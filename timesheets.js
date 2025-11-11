// ==UserScript==
// @name         BSC Time sheets
// @namespace    http://tampermonkey.net/
// @version      2025-11-10
// @description  try to take over the world!
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
    var AUTOSAVE = true;

//  if (typeof TIMESHEETALERTS === undefined) {TIMESHEETALERTS = false;}
//  if (typeof AUTOSAVE === undefined) {AUTOSAVE = true;}

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

  function getProjectRowsInfo(dayHeaders) {
    return Array.from(document.querySelectorAll("tbody tr")).map(tr => {
      const penultCols = tr.querySelectorAll('td.sticky-penultimate-column');
      if (!penultCols.length) return null;
      const hours = parseNum(penultCols[0]?.querySelectorAll('div')[1]?.textContent || "");
      if (!hours) return null;
      const allDayCells = Array.from(tr.querySelectorAll('td.hour-input-cell'));
      let inputsByDay = [];
      for (let i = 0; i < dayHeaders.length; ++i) {
        let td = allDayCells[i];
        if (!td) {
          inputsByDay.push(null);
        } else {
          let inp = td.querySelector("input.input-hours");
          let kind = td.style.backgroundColor=='pink' ? 'FULLDAY' : 'NORMAL';
          if (inp){
              if (inp && inp.disabled) inp = null;
              inp.daytype = kind;
              inputsByDay.push(inp || null);
          }else{
            let span = td.querySelector("span");
            inputsByDay.push(span);
          }
        }
      }
      return { tr, hours, inputsByDay };
    }).filter(Boolean);
  }

  function getValue(inp){
      if (!inp) return 0;
      if (inp.value !== "" && inp.value != null) {
          return parseNum(inp.value);
      } else {
          if (inp.innerText !== "") {
            return parseNum(inp.innerText);
          }
      }
      return 0
  }

  function autofill() {

    const dayHeaders = getDayHeaders();
    const projects = getProjectRowsInfo(dayHeaders);
      // erase current information
    projects.forEach(proj => {
      proj.availHours = proj.hours;
      proj.inputsByDay.forEach(inp => {
        if (inp && !inp.disabled && inp.daytype == "NORMAL" ) inp.value = "";
        if (inp && !inp.disabled && inp.daytype == "FULLDAY" ) {
            // full days (travel, etc) are pre-filled so they don't count
            proj.availHours -= 7.5;
            inp.value = "7,5";
        }
      });
    });

      let percentShare = projects.map((proj, row) => {
          proj.hours;
      });
      let totalWorkingHours = percentShare.reduce((a,b)=>a+b,0);
      percentShare = projects.map((proj, row) => {
          proj.hours/totalWorkingHours;
      });

    const workingDays = dayHeaders
      .map((hdr, idx) => hdr.isWeekend ? null : idx)
      .filter(idx => idx !== null);

    // For each day, fill out until no more hours are available
    for (let di = 0; di < workingDays.length; ++di) {
      let idx = workingDays[di];

      // For all projects, compute known/pre-filled values for this day
      let sumPreFilled = 0;
      let fillRequests = [];

      projects.forEach(proj => {
        // We first look at pre-filled values to see how many hours we need to fill for this day
        let inp = proj.inputsByDay[idx];
        if (!inp) return;
        if (inp.value !== "") {
          sumPreFilled += getValue(inp);
        } else {
          if (inp.innerText !== "") {
            sumPreFilled += getValue(inp);
          } else {
            fillRequests.push({ proj, inp, idx });
          }
        }
      });

      // Proportionally allocate the remaining hours
      let totalHoursLeft = 7.5 - sumPreFilled;


      // Gather for each project: remaining to allocate and slots left
      let remainHoursArr = fillRequests.map((fq, row) => {
        // For this project, total hours minus sum of all currently filled cells in this row
        let inputVals = fq.proj.inputsByDay.map((inp2,i) => getValue(inp2));
        let sumSoFar = inputVals.reduce((a,b)=>a+b,0);
        // Empty slots in this project (this row) that are editable and empty
        let emptySlotsProj = fq.proj.inputsByDay.filter(inp2 => inp2 && inp2.value === "").length;
        let rem = Math.max(0, fq.proj.availHours - sumSoFar);
        // If no slots left, give zero (should not happen!)
        let avg = emptySlotsProj ? rem / emptySlotsProj : 0;
        //
        //let actualHours = roundHalf(totalHoursLeft * (rem/totalShare))
        return {"avg": avg, "rem": rem};
      });


      let totalShare = 0;
       remainHoursArr.forEach((a) => {totalShare += a.avg; return null}) ;

      // Distribute according to share, respecting 0.5 increments
      let allocs = remainHoursArr.map( item => {
            let intent = roundHalf(totalHoursLeft * (item.avg/totalShare));
            return Math.min(intent,item.rem);
       });
      // Adjust for rounding drift so all missing cells are filled
      let drift = totalHoursLeft - allocs.reduce((a,b)=>a+b,0);
      let adj = 0;
        // the following has a bug I cannot fix (Fer)
     /* while (Math.abs(drift) >= 0.26 && adj < fillRequests.length*2 && allocs.length) {
        if (drift > 0) allocs[adj%allocs.length] += 0.5;
        else if (drift < 0 && allocs[adj%allocs.length] >= 0.5) allocs[adj%allocs.length] -= 0.5;
        drift = totalHoursLeft - allocs.reduce((a,b)=>a+b,0);
        adj++;
      }*/

      // Now do the actual filling
      fillRequests.forEach((fq, i) => {
        let valToSet = allocs[i] > 0 ? allocs[i] : 0;
        fq.inp.value = valToSet.toString().replace('.', ',');
      });
    }

    // After all, if any cell is still empty, set it to zero
    projects.forEach(proj =>
      proj.inputsByDay.forEach(inp=>{
        if(inp && inp.value === "") inp.value = "0";
      })
    );

    if (TIMESHEETALERTS) {alert("¡Las celdas vacías han sido rellenadas proporcionalmente, las horas han sido puestas en 0 donde corresponde!");}
    if (AUTOSAVE) { saveALL();}
  }

  // Erase all function
  function eraseAll() {
    const dayHeaders = getDayHeaders();
    const projects = getProjectRowsInfo(dayHeaders);
    projects.forEach(proj => {
      proj.inputsByDay.forEach(inp => {
        if (inp && !inp.disabled) inp.value = "";
      });
    });
    if (TIMESHEETALERTS) {alert("Todas las celdas editables han sido borradas.");}
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
        // To put eraseAll *below* autofill, insert after if already present
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

  function addButton(label, id, iconClass, callback) {
    let added = false;
    function tryAddBut() {
      const flex = document.querySelector('div.justify-content-center');
      if (flex && !document.getElementById(id)) {
        const button = document.createElement('button');// <button id="saveAllButton" class="btn btn-success">Save All</button>
        button.className = "btn btn-danger";
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
            // Reemplaza la coma por un punto para asegurar el correcto parsing del valor decimal
            var originalValue = input.getAttribute('data-original-value').replace(',', '.');
            var currentValue = input.value.replace(',', '.');

            // Parsea ambos valores como flotantes
            originalValue = parseFloat(originalValue);
            currentValue = parseFloat(currentValue);

            // Validación de que el valor sea entero o decimal con .5
                if (isNaN(currentValue) || currentValue < 0) {
                    invalidInputs.push(input);
                } else {
                if (Math.round(currentValue * 100) / 100 !== Math.round(originalValue * 100) / 100) {
                    changedTimesheets.push({
                        ProjectId: parseInt(input.getAttribute('data-projectid'), 10),
                        WpId: parseInt(input.getAttribute('data-wpid'), 10),
                        PersonId: 509,
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
  // addUtilidadesMenuButton("Rellenar Proporcionalmente", "tm-autofill-prop", "bi bi-magic", autofill);
    addUtilidadesMenuButton("Turn alerts on", "tm-alerts-prop", "bi bi-magic", switchAlerting );
    addUtilidadesMenuButton("Turn autosave off", "tm-autosave-prop", "bi bi-magic", switchSaving );

    addButton("Fill out", "autofill-button", "", autofill);

})();


