// ==UserScript==
// @name        FARecorder
// @description Records forgotten base attacks to the cloud for analysis
// @namespace   https://cncapp*.alliances.commandandconquer.com/*/index.aspx*
// @include     https://cncapp*.alliances.commandandconquer.com/*/index.aspx*
// @icon        https://project-exception.net/download/scanner.png
// @updateURL   n/a
// @downloadURL n/a
// @version     1.0.2
// @author      chirpas/xxsly
// ==/UserScript==


(function() {

    let main = () => {
                
        function CreateFARecorder(){
        const googleWebbAppURI  = "https://script.google.com/macros/s/AKfycbxaLUj522qCxIccGER2G2sw08fvPpt7sZRP8xpveIFHe73o5Ir9lWgTwQ_c5_g9CBYrew/exec";
        qx.Class.define("FARecorder", {
            type : "singleton",
            extend : qx.core.Object,
            construct : function() {
                this.__init();
            },
            statics : {
                localStorageKey : `FARecorder_${ClientLib.Data.MainData.GetInstance().get_Server().get_WorldId()}`,
                faRange : 10,
                activeWorlds : [364, 438, 439],
                updateTimeInterval : 15, //minutes
                verbose : true,
                toggleLogging : function () {FARecorder.verbose = !FARecorder.verbose}
            },
            members : {
                __cache : {
                    googleRecords : null,
                    baseCounts : null
                },
                __shouldStop : false,
                __request : {
                    isExec : false, 
                    p : null
                },
                __combatReports : [],
                __reports : null,
                __log : function(str){
                    FARecorder.verbose ? console.log(`[FARecorder] ${str}`) : '';
                },
                __loop : function(){
                //retrieve and process reports every 10 minutes;
                let pLoop = new Promise(resolve => {
                    //update cache with existing records in tracker
                    this.__getGoogleSheetRecords().then(d => {
                        this.__cache.googleRecords = d.values;
                    }).then(() => {
                        //get cached base counts.
                        let _baseCounts = localStorage.getItem(FARecorder.localStorageKey)
                        this.__cache.baseCounts = _baseCounts != null ? JSON.parse(_baseCounts) : {};
                    }).then(() => {
                        //get report data
                        this.__getReportData().then(() => {
                            //massage data and post to google sheets
                            let uploadedData = this.__createUploadData()
                            this.__setBasesInRange();
                            if(uploadedData.length > 0){
                                this.__log(`Uploading ${uploadedData.length} records.`)
                                this.__postGoogleSheetRecords(uploadedData).then(() => {
                                    this.__log(`Next update in ${FARecorder.updateTimeInterval} minutes.`);
                                    resolve();
                                });
                            } else {
                                this.__log(`Next update in ${FARecorder.updateTimeInterval} minutes.`);
                                resolve();
                            }
                        });
                    });
                });

                
                pLoop.then(() => new Promise(resolve => setTimeout(resolve, FARecorder.updateTimeInterval * 60 * 1000))).then(() => {
                    if(!this.__shouldStop){
                        this.__log('Performing Update.')
                        this.__loop();
                    } else {
                        this.__log('Updates halted.')
                    }
                })
                },
                __init : function(){
                this.__shouldStop = false;
                this.__cache = {
                    googleRecords : [],
                    baseCounts : {}
                }
                
                this.__request = {
                    isExec : false, 
                    p : null
                };
                this.__registerAliasGetReportData();
                this.__registerAliasInstantiateReport();
                this.__reports = new ClientLib.Data.Reports.Reports();
                this.__reports.Init();

                let server = ClientLib.Data.MainData.GetInstance().get_Server()
                if(FARecorder.activeWorlds.includes(server.get_WorldId())){
                    this.__log("Entering main loop.")
                    this.__loop();
                } else {
                    this.__log(`Not running for world: ${server.get_Name()}`)
                }
                },
                killMe : function(){
                this.__log('Halting after current run');
                this.__shouldStop = true;
                },
                reviveMe : function(){
                this.__log('Reviving process');
                this.__shouldStop = false;
                this.__loop();
                },
                __getBasesInRange : function(){
                return JSON.parse(localStorage.getItem(FARecorder.localStorageKey));
                },
                __calculateBasesInRange : function(x,y){
                //courtesy of TA Wavey 0.5.6
                let world = ClientLib.Data.MainData.GetInstance().get_World();
                let maxR2 = FARecorder.faRange * FARecorder.faRange;
                let minX = x - FARecorder.faRange;
                let maxX = x + FARecorder.faRange;
                let minY = y - FARecorder.faRange;
                let maxY = y + FARecorder.faRange;
                var bases = [];

                for(let scanX = minX; scanX <= maxX; scanX++){
                    for(let scanY = minY; scanY <= maxY; scanY++){
                        let r2 = (x - scanX)**2 + (y-scanY)**2;
                        if(r2 > maxR2){
                            continue;
                        }

                        var worldObject = world.GetObjectFromPosition(scanX, scanY);
                        if(worldObject !== null && worldObject.Type == ClientLib.Data.WorldSector.ObjectType.NPCBase){
                            bases.push(worldObject);
                        }
                    }
                }

                return bases.length;
                },
                __setBasesInRange : function(){
                /*get bases in range the last time the script was run.
                    The idea is that:
                        -> get cached number of bases around all cities when script was last run
                        -> use base count for new reports. Old reports will already exist in google sheet and wont be processed
                        -> base count estimate assigned to reports and records uploaded
                        -> number of bases around all cities is calculated and stored in browser storage
                        -> 10-15 minutes until next poll
                    It's not perfect, but I dont see a better way to do it.
                */
                
                let cacheData = {}
                let playerCities = ClientLib.Data.MainData.GetInstance().get_Cities().get_AllCities().d;
                Object.entries(playerCities).forEach(([baseId, baseObj]) => {
                    cacheData[baseId] = this.__calculateBasesInRange(baseObj.get_PosX(),baseObj.get_PosY());
                });
                localStorage.setItem(FARecorder.localStorageKey, JSON.stringify(cacheData))
                },
                __getRecordHash : function(r){
                let str = `${r.get_DefenderPlayerName()}-${r.get_DefenderBaseId()}-${r.get_AttackerBaseId()}`
                let hashFunc = (b) => {for(var a=0,c=b.length;c--;)a+=b.charCodeAt(c),a+=a<<10,a^=a>>6;a+=a<<3;a^=a>>11;return((a+(a<<15)&4294967295)>>>0).toString(16)};
                return hashFunc(str);
                },
                __mapReportRecord : function(r){
                    let getWaveCount = (baseCount) => {
                        if(baseCount < 20){
                            return 1;
                        } else if (baseCount >= 20 && baseCount < 30){
                            return 2;
                        } else if (baseCount >= 30 && baseCount < 40){
                            return 3;
                        } else if (baseCount >= 40 && baseCount < 50){
                            return 4;
                        } else {
                            return 5;
                        }
                    }
                    let world = ClientLib.Data.MainData.GetInstance().get_World();
                    let ox = world.get_WorldWidth();
                    let oy = world.get_WorldHeight();
                    let bx = r.get_DefenderBaseXCoord();
                    let by = r.get_DefenderBaseYCoord();
                    let d = Math.sqrt((ox-bx)**2 + (oy-by)**2);
                    let baseCount = this.__cache.baseCounts[String(r.get_DefenderBaseId())];
                    let playerBaseCount = Object.values(this.__cache.baseCounts).length;
                    let playerBasesWithNoneInRange = Object.values(this.__cache.baseCounts).filter(bc => bc == 0).length

                    let rmap = {
                        encounterId : this.__getRecordHash(r),
                        epoch : r.get_Time(),
                        time : new Date(r.get_Time()).toISOString(),
                        atkBaseName : r.get_AttackerBaseName(),
                        attackerBaseId : r.get_AttackerBaseId(),
                        atkBaseLevel : r.get_AttackerBaseLevel(),
                        atkBaseX : r.get_AttackerBaseXCoord(),
                        atkBaseY : r.get_AttackerBaseYCoord(),
                        defPlayerName : r.get_DefenderPlayerName(),
                        defBaseId : r.get_DefenderBaseId(),
                        defBaseX : bx,
                        defBaseY : by,
                        waves : typeof(baseCount) == 'undefined' ? -1 : getWaveCount(baseCount),
                        dFromFort : Math.floor(d),
                        lastPlayerAttack : this.__getTimeSinceLastPlayerAttack(r.get_Id()),
                        lastBaseAttack : this.__getTimeSinceLastBaseAttack(r.get_Id(), r.get_DefenderBaseId()),
                        pBaseCount : playerBaseCount,
                        pBaseNoBasesInRange : playerBasesWithNoneInRange
                    }

                    let mappedRecord = [rmap.encounterId,rmap.epoch,rmap.defPlayerName,rmap.defBaseId,rmap.defBaseX,rmap.defBaseY,rmap.time,rmap.atkBaseName,rmap.attackerBaseId,rmap.atkBaseLevel,rmap.atkBaseX,rmap.atkBaseY,rmap.waves,rmap.dFromFort,rmap.lastPlayerAttack,rmap.lastBaseAttack,rmap.pBaseCount,rmap.pBaseNoBasesInRange];
                    return mappedRecord;
                },
                __getTimeSinceLastBaseAttack(reportId, baseId){
                    let localReports = Object.entries(this.__reports.getData().d).map(([id, report]) => {
                        return {id : id, baseId : report.get_BaseId(), time : report.get_Time()};
                    }).filter(report => report.baseId == baseId);
                    let cacheReports = this.__cache.googleRecords.filter(record => record[3] == baseId).map(record => {
                        return {id : record[0], baseId : record[3], time : record[1]}
                    });
                    let reports = [...localReports, ...cacheReports].filter(record => {
                        return record.baseId == baseId;
                    }).sort((a, b) => a.time-b.time);
                    let i = reports.findIndex(r => r.id == reportId);

                    let dt = 0;
                    if(i > 0){
                        dt = reports[i].time - reports[i-1].time
                    }
                    return dt;
                },
                __getTimeSinceLastPlayerAttack(reportId){
                const playerName = ClientLib.Data.MainData.GetInstance().get_Player().get_Name();
                let localReports = Object.entries(this.__reports.getData().d).map(([id, report]) => {
                    return {id : id, time : report.get_Time()};
                })
                let cacheReports = this.__cache.googleRecords.filter(record => record[2] == playerName).map(record => {
                    return {id : record[0], time : record[1]}
                })
                let reports = [...localReports, ...cacheReports].sort((a, b) => a.time-b.time);
                let i = reports.findIndex(r => r.id == reportId);
                
                //very rare edge case where no player report is within the cache or within the last 5000 records in the sheet. in this case, 0 is returned.
                let dt = 0;
                if(i > 0){
                    dt = reports[i].time - reports[i-1].time
                }
                return dt;
                },
                __createUploadData(){
                let package = [];
                let records = []
                /*search time factor. Dont want to include multiple instances of the same report with a slightly different time for multiwave attacks.
                    Based on empirical data, time between attacks is usually 2:30 minutes. To give a bit of a buffer, assume max time between hits is 4 minutes and with up to 5 wave
                    zones, assume any attack within 20 minutes on the same base is part of the same attack.
                */
                const dt = 20 * 60 * 1000; //ms

                //First, filter against google records
                Object.values(this.__reports.getData().d).forEach(r => {
                    let attackTime = r.get_Time();
                    let recordHash = this.__getRecordHash(r);
                    let filteredCache = this.__cache.googleRecords.filter(gr => gr[0] == recordHash).map(fr => {
                        return Math.abs(attackTime - parseInt(fr[1])) <= dt ? true : false;
                    });

                    //if no attack is within close proximity of an existing record in cache...
                    if(!filteredCache.includes(true)){
                        //check if a staged record in close time proximity exists
                        filteredCache = records.map(stagedRecord => stagedRecord.get_Time()).map(t => {
                            return Math.abs(attackTime - t) <= dt ? true : false;
                        });
                        if(!filteredCache.includes(true)){
                            records.push(r);
                        }
                    }
                });
                package = records.map(r => {
                    return this.__mapReportRecord(r);
                });
                return package;
                },
                __getGoogleSheetRecords(){
                return new Promise((resolve, reject) => {
                    const worldId = ClientLib.Data.MainData.GetInstance().get_Server().get_WorldId();

                    fetch(`${googleWebbAppURI}?wid=${worldId}`, {
                        method: 'GET',
                        redirect : 'follow',
                        headers: {
                            'Content-Type': 'text/plain;charset=utf-8',
                        }
                    }).then(response => {
                        return response.json()
                    }).then(data => {
                        resolve(data);
                    }).catch(err => {
                        this.__log(`Error: ${err}`);
                        reject(response);
                    });
                });
                },
                __postGoogleSheetRecords(data){
                return new Promise((resolve, reject) => {
                    const worldId = ClientLib.Data.MainData.GetInstance().get_Server().get_WorldId();
                    fetch(googleWebbAppURI, {
                        method: 'POST',
                        body: JSON.stringify({wid:worldId, d:data}),
                        headers: {
                            'Content-Type': 'text/plain;charset=utf-8',
                        }
                    }).then(response => {
                        resolve(response)
                    }).catch(err => {
                        this.__log(`Error: ${err}`);
                        reject(response);
                    });
                })
                },
                __getReportCount : function(){
                return new Promise(resolve => {
                    ClientLib.Net.CommunicationManager.GetInstance().SendSimpleCommand("GetReportCount", {
                        playerReportType: ClientLib.Data.Reports.EPlayerReportType.NPCPlayerCombat
                    }, phe.cnc.Util.createEventDelegate(ClientLib.Net.CommandResult, this, function (a, nRecords) {
                        resolve(nRecords);
                    }));
                })
                },
                __getReportHeaders : function(n){
                return new Promise(resolve => {
                    ClientLib.Net.CommunicationManager.GetInstance().SendSimpleCommand("GetReportHeaderAll", {
                        type: ClientLib.Data.Reports.EPlayerReportType.NPCPlayerCombat,
                        skip: 0,
                        take: n,
                        sort: ClientLib.Data.Reports.ESortColumn.Time,
                        ascending: false
                    }, phe.cnc.Util.createEventDelegate(ClientLib.Net.CommandResult, this, function (a, records) {
                        resolve(records);
                    }), null)
                });
                },
                __getReportDetailed : function(id){
                return new Promise(resolve => {
                    ClientLib.Net.CommunicationManager.GetInstance().SendSimpleCommand("GetReportData", {
                        playerReportId : id,
                    }, phe.cnc.Util.createEventDelegate(ClientLib.Net.CommandResult, this, function (a, data) {
                        resolve(data);
                    }), null)
                });
                },
                __getReportData : function(){
                const pseudoThreadCount = 5;
                this.__request.isExec = true;
                /*store data as:
                {<reportId> : {h : <report header data>, d : <report full data>}, ...}*/
                let tmp = [];
                this.__request.p = new Promise(resolve => {
                    this.__getReportCount().then((n) => {
                        this.__getReportHeaders(n).then(records => {
                            
                            //get all records that aren't currently registered in the reports manager
                            records = records.filter(r => {
                                return !Object.keys(this.__reports.getData().d).includes(String(r.i));
                            });

                            //anon func to synchronously retrieve detailed report data
                            let ids = records.map(r => r.i);
                            let pThreads = [];
                            var i = 0;
                            let p = null;

                            let spawnPseudoThread = () => {
                                return new Promise(_res => {

                                    let retrieveData = (index) => {
                                        i++;
                                        if(index < ids.length){
                                            this.__getReportDetailed(ids[index]).then((detailedReport) => {
                                                tmp.push({h : records[index], d : detailedReport})
                                                retrieveData(i);
                                            });
                                        }
                                        else {
                                            _res();
                                        }
                                    };
                                    
                                    retrieveData(i);
                                })
                            }

                            for(let pthrd = 0; pthrd < pseudoThreadCount; pthrd++){
                                pThreads.push(spawnPseudoThread());
                            }

                            Promise.allSettled(pThreads).then(() => {
                                tmp.forEach(r => {
                                    this.__reports.pushNewReport(r.h, r.d);
                                });
                                this.__log(`Finished downloading ${tmp.length} record(s)`)
                                this.__request.isExec = false;
                                resolve();
                            })
                        })
                    })
                })
                return this.__request.p;
                },
                __registerAliasInstantiateReport : function(){
                let funcSrc = ClientLib.Data.Reports.Reports.prototype.AddReport.toString();
                let matches = /.*;(this\..*\))/.exec(funcSrc);
                if(matches == null || (matches != null && !matches[matches.length-1].includes(ClientLib.Data.Reports.ReportDelivered.$I))){
                    //assert error and halt module
                    this.__log('__registerAliasReportCreate : assert error and halt module')
                } else {
                    let funcSrcParams = /\(.{1,5},.{1,5}\)/.exec(funcSrc)[0];
                    funcSrc = funcSrc.substr(funcSrc.indexOf(funcSrcParams) + funcSrcParams.length, funcSrc.length)
                    funcSrcParams = funcSrcParams.substr(1, funcSrcParams.length-2).split(',');
                    let funcReportVar = /[a-zA-Z]{1,5}\b=null/.exec(funcSrc)[0].replace('=null', '');
                    funcSrc = funcSrc.replace(matches[matches.length-1], `this.getData().d[${funcSrcParams[0]}.i]=${funcReportVar};this.getData().c++;`);

                    ClientLib.Data.Reports.Reports.prototype.pushNewReport = new Function(funcSrcParams[0], funcSrcParams[1], `${funcSrc}`);
                }
                },
                __registerAliasGetReportData : function(){
                let matches = /([A-Z]{6,12})/.exec(ClientLib.Data.Reports.Reports.prototype.Init);
                if(matches == null){
                    //assert error and halt module
                    this.__log('__registerAliasGetReportData : assert error and halt module')
                } else {
                    ClientLib.Data.Reports.Reports.prototype.getData = new Function(`return this.${matches[0]};`);
                }
                }
            }
        });

        var FALibrarian = new FARecorder();
        }

        function TALoadCheck() {
            try {
                if(typeof qx !== "undefined" && qx.core.Init.getApplication() !== null && (typeof(ClientLib.Data.MainData.GetInstance().get_Server) !== 'undefined' && ClientLib.Data.MainData.GetInstance().get_Server !== null)) {
                    CreateFARecorder();
                } else {
                    setTimeout(TALoadCheck, 5000);
                }
            } catch (err) {
              console.debug(`[FARecorder] failed to initialise. ${err}`);
            }
        };

        setTimeout(TALoadCheck, 5000);
    }

    var script = document.createElement("script");
    script.id = "FARecorder";
    script.innerHTML = `(${main.toString()})();`;
    script.type = "text/javascript";
    document.getElementsByTagName("head")[0].appendChild(script);
})();