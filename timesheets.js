// ==UserScript==
// @name         BSC Time sheets
// @namespace    http://tampermonkey.net/
// @version      2026-03-05
// @description  Auto-fill BSC timesheets
// @author       You
// @match        https://opstrs03.bsc.es/Time*heet/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=bsc.es
// @grant        none
// ==/UserScript==


(function () {
  'use strict';

  function parseNum(s) { return parseFloat(String(s).replace(',', '.')) || 0; }
  function roundHalf(n) { return Math.round(n * 2) / 2; }

    var TIMESHEETALERTS = false;
    var AUTOSAVE = false;

  function getDayHeaders() {
    return Array.from(document.querySelectorAll('thead th.sticky-day-header')).map(th => {
      const divs = th.querySelectorAll("div");
      let dow = divs[1]?.textContent?.trim().toUpperCase();
      return {
        th,
        dayNum: divs[0]?.textContent?.trim(),
        dow,
        isWeekend: (dow === 'SAT' || dow === 'SUN')
      };
    });
  }

  // Read target hours per day from the tfoot row (second div = target)
  function getDailyTargetHours(dayHeaders) {
    const tfootRow = document.querySelector('tfoot tr');
    if (!tfootRow) return dayHeaders.map(() => 7.5);
    const cells = Array.from(tfootRow.querySelectorAll('td'));
    return cells.map(td => {
      const divs = td.querySelectorAll('div');
      // Second div is the target hours for that day
      return divs[1] ? parseNum(divs[1].textContent.trim()) : 0;
    });
  }

  function getProjectRowsInfo(dayHeaders) {
    return Array.from(document.querySelectorAll("tbody tr")).map(tr => {
      const penultCols = tr.querySelectorAll('td.sticky-penultimate-column');
      if (!penultCols.length) return null;
      const hours = parseNum(penultCols[0]?.querySelectorAll('div')[1]?.textContent || "");
      if (hours != "0" && !hours) return null;
      const allDayCells = Array.from(tr.querySelectorAll('td.hour-input-cell'));
      let inputsByDay = [];
      for (let i = 0; i < dayHeaders.length; ++i) {
        let td = allDayCells[i];
        if (!td) {
          inputsByDay.push(null);
        } else {
          let inp = td.querySelector("input.input-hours");
          if (inp){
              if (inp.disabled) inp = null;
              inputsByDay.push(inp || null);
          } else {
            // Weekend or non-editable cell with a span
            let span = td.querySelector("span");
            inputsByDay.push(span || null);
          }
        }
      }
      return { tr, hours, inputsByDay };
    }).filter(Boolean);
  }

  function getValue(inp){
      if (!inp) return 0;
      if (inp.value !== undefined && inp.value !== "" && inp.value != null) {
          return parseNum(inp.value);
      }
      if (inp.innerText && inp.innerText.trim() !== "") {
          return parseNum(inp.innerText);
      }
      return 0;
  }

  function isEditable(inp) {
      return inp && inp.tagName === 'INPUT' && !inp.disabled;
  }

  function autofill() {

    const dayHeaders = getDayHeaders();
    const dailyTargets = getDailyTargetHours(dayHeaders);
    const projects = getProjectRowsInfo(dayHeaders);

    // Compute available hours per project (estimated minus any pre-filled travel/full-day values)
    projects.forEach(proj => {
      proj.availHours = proj.hours;
    });

    // Clear all editable normal cells first
    projects.forEach(proj => {
      proj.inputsByDay.forEach(inp => {
        if (isEditable(inp)) inp.value = "";
      });
    });

    const workingDays = dayHeaders
      .map((hdr, idx) => hdr.isWeekend ? null : idx)
      .filter(idx => idx !== null);

    // For each working day, fill out proportionally
    for (let di = 0; di < workingDays.length; ++di) {
      let idx = workingDays[di];
      let dailyTarget = dailyTargets[idx] || 7.5;

      // For all projects, compute known/pre-filled values for this day
      let sumPreFilled = 0;
      let fillRequests = [];

      projects.forEach(proj => {
        let inp = proj.inputsByDay[idx];
        if (!inp) return;
        if (!isEditable(inp)) {
          // Non-editable (span or disabled): count its value
          sumPreFilled += getValue(inp);
        } else if (inp.value !== "") {
          // Already has a value (pre-filled)
          sumPreFilled += getValue(inp);
        } else {
          fillRequests.push({ proj, inp, idx });
        }
      });

      // Remaining hours to distribute for this day
      let totalHoursLeft = dailyTarget - sumPreFilled;

      // For each fillable project, compute average remaining hours per empty slot
      let remainHoursArr = fillRequests.map(fq => {
        let inputVals = fq.proj.inputsByDay.map(inp2 => getValue(inp2));
        let sumSoFar = inputVals.reduce((a,b)=>a+b,0);
        let emptySlotsProj = fq.proj.inputsByDay.filter(inp2 => isEditable(inp2) && inp2.value === "").length;
        let rem = Math.max(0, fq.proj.availHours - sumSoFar);
        let avg = emptySlotsProj ? rem / emptySlotsProj : 0;
        return {"avg": avg, "rem": rem};
      });

      let totalShare = remainHoursArr.reduce((a, item) => a + item.avg, 0);

      // Distribute according to share, respecting 0.5 increments
      let allocs;
      if (totalShare > 0) {
        allocs = remainHoursArr.map(item => {
          let intent = roundHalf(totalHoursLeft * (item.avg / totalShare));
          return Math.min(intent, item.rem);
        });
      } else {
        allocs = remainHoursArr.map(() => 0);
      }

      // Fix rounding drift
      let drift = roundHalf(totalHoursLeft - allocs.reduce((a,b)=>a+b,0));
      let adj = 0;
      while (Math.abs(drift) >= 0.25 && adj < fillRequests.length * 4 && allocs.length) {
        let i = adj % allocs.length;
        if (drift > 0 && remainHoursArr[i].rem > allocs[i]) {
          allocs[i] += 0.5;
        } else if (drift < 0 && allocs[i] >= 0.5) {
          allocs[i] -= 0.5;
        }
        drift = roundHalf(totalHoursLeft - allocs.reduce((a,b)=>a+b,0));
        adj++;
      }

      // Do the actual filling
      fillRequests.forEach((fq, i) => {
        let valToSet = allocs[i] > 0 ? allocs[i] : 0;
        fq.inp.value = valToSet.toString().replace('.', ',');
      });
    }

    // After all, if any editable cell is still empty, set it to zero
    projects.forEach(proj =>
      proj.inputsByDay.forEach(inp => {
        if (isEditable(inp) && inp.value === "") inp.value = "0";
      })
    );

    if (TIMESHEETALERTS) {alert("Timesheet filled out proportionally!");}
    if (AUTOSAVE) { saveALL();}
  }

  // Erase all function
  function eraseAll() {
    const dayHeaders = getDayHeaders();
    const projects = getProjectRowsInfo(dayHeaders);
    projects.forEach(proj => {
      proj.inputsByDay.forEach(inp => {
        if (isEditable(inp)) inp.value = "0";
      });
    });
    if (TIMESHEETALERTS) {alert("All editable cells have been cleared.");}
  }

  // Server-side auto-fill (uses the built-in API)
  function serverAutoFill() {
    const urlParams = new URLSearchParams(window.location.search);
    const personId = urlParams.get('personId') || document.querySelector('[data-projectid]')?.closest('tr')?.querySelector('input.input-hours')?.getAttribute('data-day')?.split('-')[0];
    const monthSelect = document.getElementById('monthSelect');
    const yearSelect = document.getElementById('yearSelect');

    // Try to get personId from inputs on the page
    let pid = urlParams.get('personId');
    if (!pid) {
      // Fallback: extract from any input's data attributes or page URL
      const firstInput = document.querySelector('input.input-hours');
      if (firstInput) {
        // personId is typically in the save endpoint; try the URL
        const match = window.location.href.match(/personId=(\d+)/);
        pid = match ? match[1] : null;
      }
    }

    let month = monthSelect?.value;
    let year = yearSelect?.value;

    if (!pid || !month || !year) {
      alert('Could not determine person/month/year. Please navigate using the Go button first.');
      return;
    }

    if (!confirm(`Auto-fill timesheet for ${month}/${year} using server logic? This may overwrite existing data.`)) return;

    fetch('/Timesheet/AutoFillTimesheetForPersonAndMonth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personId: parseInt(pid, 10),
        targetMonth: `${year}-${String(month).padStart(2, '0')}-01T00:00:00`
      })
    })
    .then(r => r.json())
    .then(data => {
      alert(data.message || (data.success ? 'Done!' : 'Error'));
      if (data.success) location.reload();
    })
    .catch(err => {
      console.error('AutoFill error:', err);
      alert('Error during auto-fill.');
    });
  }

  function waitTable(fn) {
    let tries = 0;
    const go = () => {
      const table = document.getElementById('timesheetTable') || document.querySelector("table");
      if (table && table.querySelectorAll('tbody tr').length) {
        fn(table);
      } else if (++tries < 20) {
        setTimeout(go, 800);
      }
    };
    go();
  }

  function addUtilidadesMenuButton(label, id, iconClass, callback) {
    let added = false;
    function tryAdd() {
      const menu = document.querySelector('ul.dropdown-menu[aria-labelledby="pmDropdown"]');
      if (menu && !document.getElementById(id)) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = "#";
        a.className = "dropdown-item";
        a.id = id;
        a.innerHTML = (iconClass ? '<i class="' + iconClass + '"></i> ' : "") + label;
        a.addEventListener('click', function (e) {
          e.preventDefault();
          waitTable(callback);
        });
        li.appendChild(a);
        let ref = document.getElementById("tm-autofill-prop");
        if (ref && id==="tm-erase-all" && ref.parentElement && ref.parentElement.nextSibling) {
          ref.parentElement.parentElement.insertBefore(li, ref.parentElement.nextSibling);
        } else {
          menu.appendChild(li);
        }
        added = true;
      }
      if (!added) setTimeout(tryAdd, 900);
    }
    tryAdd();
  }

  function addButton(label, id, className, callback) {
    let added = false;
    function tryAddBut() {
      // Try the new layout first, then fall back to old
      const flex = document.querySelector('div.timesheet-actions-group')
                || document.querySelector('div.justify-content-center');
      if (flex && !document.getElementById(id)) {
        const button = document.createElement('button');
        button.className = className || "btn btn-danger";
        button.innerHTML = label;
        button.id = id;
        button.addEventListener('click', function (e) {
          e.preventDefault();
          waitTable(callback);
        });
        flex.appendChild(button);
        added = true;
      }
      if (!added) setTimeout(tryAddBut, 900);
    }
    tryAddBut();
  }

    function switchAlerting() {
        var element = document.getElementById("tm-alerts-prop");
        if (TIMESHEETALERTS) {
            element.innerHTML = "Turn alerts ON";
            TIMESHEETALERTS = false;
        }
        else {
            element.innerHTML = "Turn alerts OFF";
             TIMESHEETALERTS = true;
        }
    }

    function switchSaving() {
        var element = document.getElementById("tm-autosave-prop");
        let button = document.getElementById("autofill-button");
        if (AUTOSAVE) {
            element.innerHTML = "Turn autosave ON";
            AUTOSAVE = false;
            button.className = "btn btn-success";
        }
        else {
            element.innerHTML = "Turn autosave OFF";
             AUTOSAVE = true;
             button.className = "btn btn-danger";
        }
    }

  function saveALL() {
        var changedTimesheets = [];
        var invalidInputs = [];

        document.querySelectorAll('.input-hours').forEach(input => {
            var originalValue = input.getAttribute('data-original-value').replace(',', '.');
            var currentValue = input.value.replace(',', '.');

            originalValue = parseFloat(originalValue);
            currentValue = parseFloat(currentValue);

                if (isNaN(currentValue) || currentValue < 0) {
                    invalidInputs.push(input);
                } else {
                if (Math.round(currentValue * 100) / 100 !== Math.round(originalValue * 100) / 100) {
                    // Extract personId from URL
                    const match = window.location.href.match(/personId=(\d+)/);
                    const personId = match ? parseInt(match[1], 10) : 509;
                    changedTimesheets.push({
                        ProjectId: parseInt(input.getAttribute('data-projectid'), 10),
                        WpId: parseInt(input.getAttribute('data-wpid'), 10),
                        PersonId: personId,
                        Day: input.getAttribute('data-day'),
                        Hours: currentValue
                    });
                }
            }
        });


        if (invalidInputs.length > 0) {
            alert('Some inputs are invalid. Please enter a positive number.');
            invalidInputs.forEach(input => input.classList.add('is-invalid'));
        } else {
            if (changedTimesheets.length > 0) {
                fetch('/Timesheet/SaveTimesheetHours', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ TimesheetDataList: changedTimesheets })
                })
                    .then(response => response.json())
                    .then(data => {
                        if (data.success) {
                            if (TIMESHEETALERTS) {alert('Timesheets updated successfully.');}
                            location.reload();
                        } else {
                            alert('Error saving timesheets.');
                        }
                    })
                    .catch(error => {
                        console.error('Error:', error);
                        alert('There was an error processing your request.');
                    });
            } else {
                if (TIMESHEETALERTS) {alert('No changes to save.');}
            }
        }
    };



    addUtilidadesMenuButton("Borrar todos", "tm-erase-all", "bi bi-trash", eraseAll);
    addUtilidadesMenuButton("Turn alerts on", "tm-alerts-prop", "bi bi-magic", switchAlerting );
    addUtilidadesMenuButton("Turn autosave off", "tm-autosave-prop", "bi bi-magic", switchSaving );

    addButton("Fill out", "autofill-button", "btn btn-success", autofill);
    addButton("Server Auto-Fill", "server-autofill-button", "btn btn-warning ms-2", serverAutoFill);

})();
// ==UserScript==
// @name         New Userscript
// @namespace    http://tampermonkey.net/
// @version      2026-03-05
// @description  try to take over the world!
// @author       You
// @match        https://opstrs03.bsc.es/Timesheet/GetTimeSheetsForPerson?personId=509&year=2026&month=2
// @icon         https://www.google.com/s2/favicons?sz=64&domain=bsc.es
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Your code here...
})();
