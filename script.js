let frames = [];
let refList = [];
let frameCount = 3;
let algo = "LRU";
let stepIndex = 0;
let fifoQueue = [];
let lastUsed = {};
let pageFrequency = {};
let secondChanceBits = {}; // Second-Chance (Clock)
let clockHand = 0;
let faults = 0;
let hits = 0;
let timelineEvents = [];
let prefetchEnabled = false;
let tutorMode = false;
let chartData = [];
let viewStart = 0;
let viewEnd = null;
let statsChart = null; // Chart.js instance

function $(id) {
    return document.getElementById(id);
}

// ---------- GSAP-BASED ANIMATION WRAPPER ----------
function animateOnce(targets, config) {
    if (!window.gsap || !targets) return;
    const duration = (config.duration || 400) / 1000;
    const easing = config.easing === "easeOutQuad" ? "power2.out" : "power1.out";

    if (config.opacity && config.translateY) {
        gsap.fromTo(
            targets,
            { opacity: config.opacity[0], y: config.translateY[0] },
            { opacity: config.opacity[1], y: config.translateY[1], duration, ease: easing }
        );
    } else if (config.scale) {
        gsap.fromTo(
            targets,
            { scale: config.scale[0] },
            { scale: config.scale[1], duration: duration / 2, yoyo: true, repeat: 1, ease: easing }
        );
    } else {
        gsap.to(targets, { ...config, duration, ease: easing });
    }
}

// ---------- LOG UI ----------
function addLogEvent({ step, page, action, frameIndex, replaced, secondaryMsg = null }) {
    const container = $("log");
    if (!container) return;

    const item = document.createElement("div");
    let cls = "log-item";
    if (action === "HIT") cls += " hit";
    else if (action === "FAULT") cls += " fault";
    item.className = cls + " animate__animated animate__fadeInUp";

    const stepTag = document.createElement("span");
    stepTag.className = "tag step";
    stepTag.textContent = `Step ${step}`;

    const pageTag = document.createElement("span");
    pageTag.className = "tag page";
    pageTag.textContent = `Page ${page}`;

    const typeTag = document.createElement("span");
    if (action === "HIT") typeTag.className = "tag type-hit";
    else if (action === "FAULT") typeTag.className = "tag type-fault";
    else typeTag.className = "tag";
    typeTag.textContent = action;

    const msg = document.createElement("span");
    msg.className = "log-message";

    if (action === "FAULT") {
        if (replaced !== null && replaced !== undefined) {
            msg.textContent = `replaced ${replaced} in F${frameIndex}`;
        } else {
            msg.textContent = `loaded into F${frameIndex}`;
        }
    } else if (action === "HIT") {
        msg.textContent = `found in F${frameIndex}`;
    } else if (action === "PREFETCH") {
        msg.textContent = `predicted next access (no fault counted)`;
    } else {
        msg.textContent = "";
    }

    if (secondaryMsg) {
        msg.textContent += secondaryMsg;
    }

    item.appendChild(stepTag);
    item.appendChild(pageTag);
    item.appendChild(typeTag);
    item.appendChild(msg);

    if (tutorMode && action !== "PREFETCH") {
        const expl = document.createElement("div");
        expl.className = "tutor-explanation";
        if (action === "FAULT") {
            expl.textContent = `Tutor: Page ${page} was not in memory (FAULT). ${algo} chose ${
                replaced !== null ? replaced : "an empty frame"
            } to replace based on its policy.`;
        } else {
            expl.textContent = `Tutor: Page ${page} was found in frame F${frameIndex} (HIT). ${algo} updated its tracking state.`;
        }
        item.appendChild(expl);
    }

    container.appendChild(item);
    container.scrollTop = container.scrollHeight;

    animateOnce(item, {
        opacity: [0, 1],
        translateY: [8, 0],
        duration: 400,
        easing: "easeOutQuad",
    });
}

function clearLog() {
    const log = $("log");
    if (log) log.innerHTML = "";
}

// ---------- TIMELINE ----------
function updateTimeline() {
    const strip = $("timelineStrip");
    if (!strip) return;

    strip.innerHTML = "";
    timelineEvents.forEach((ev) => {
        const dot = document.createElement("span");
        dot.className = "timeline-dot " + (ev.action === "HIT" ? "hit" : "fault");
        dot.title = `Step ${ev.step}: Page ${ev.page} -> ${ev.action}`;
        strip.appendChild(dot);
    });
}

// ---------- STATS + TABLE + MEMORY MAP ----------
function updateStats() {
    const fEl = $("faultCount");
    const hEl = $("hitCount");
    const rEl = $("hitRatio");
    const frEl = $("faultRate");

    if (fEl) fEl.textContent = faults;
    if (hEl) hEl.textContent = hits;

    const total = faults + hits;
    const ratio = total === 0 ? 0 : hits / total;
    const faultRate = total === 0 ? 0 : faults / total;

    if (rEl) rEl.textContent = ratio.toFixed(2);
    if (frEl) frEl.textContent = (faultRate * 100).toFixed(1) + "%";

    animateOnce(fEl, { scale: [1, 1.15, 1], duration: 300, easing: "easeOutQuad" });
    animateOnce(hEl, { scale: [1, 1.15, 1], duration: 300, easing: "easeOutQuad" });
    animateOnce(rEl, { scale: [1, 1.15, 1], duration: 300, easing: "easeOutQuad" });
    animateOnce(frEl, { scale: [1, 1.15, 1], duration: 300, easing: "easeOutQuad" });

    chartData.push({ step: stepIndex, faults, hits, ratio });
    updateStatsChart();
}

function drawTable(highlightIndex = null) {
    const tbl = $("frameTable");
    if (!tbl) return;

    const hasRbit = algo === "Second-Chance";
    let html = `<tr><th>Frame</th><th>Page${hasRbit ? " (R)" : ""}</th></tr>`;

    for (let i = 0; i < frameCount; i++) {
        const val = frames[i] === -1 ? "-" : frames[i];
        let displayVal = val;
        if (hasRbit && val !== "-") {
            const rbit = secondChanceBits[val] ?? 0;
            displayVal = `${val} (${rbit})`;
        }
        const cls = i === highlightIndex ? "highlight-cell" : "";
        html += `<tr>
            <td>F${i}</td>
            <td class="${cls}">${displayVal}</td>
        </tr>`;
    }
    tbl.innerHTML = html;

    if (highlightIndex !== null && highlightIndex >= 0) {
        const cell = document.querySelector(".highlight-cell");
        if (cell) {
            animateOnce(cell, {
                scale: [1, 1.08, 1],
                duration: 350,
                easing: "easeOutQuad",
            });
        }
    }
}

function updateMemoryMap() {
    const tbl = $("memoryMapTable");
    if (!tbl || !refList.length) return;

    const uniquePages = Array.from(new Set(refList));
    let html = "<tr><th>Page</th><th>Status</th><th>Access Count</th><th>Last Used Step</th></tr>";

    uniquePages.forEach((p) => {
        const inRam = frames.includes(p);
        const freq = pageFrequency[p] || 0;
        const last = lastUsed[p];
        const status = inRam ? "In RAM" : "Not in RAM";
        html += `<tr>
            <td>${p}</td>
            <td>${status}</td>
            <td>${freq}</td>
            <td>${last === undefined ? "-" : last}</td>
        </tr>`;
    });

    tbl.innerHTML = html;
}

// ---------- INPUT & RESET ----------
function readInputs() {
    const framesInput = $("frames");
    const refsInput = $("refs");
    const algoSelect = $("algo");
    const prefetchToggle = $("prefetchToggle");
    const tutorToggle = $("tutorModeToggle");

    if (!framesInput || !refsInput || !algoSelect) return false;

    frameCount = parseInt(framesInput.value || "0", 10);
    if (isNaN(frameCount) || frameCount <= 0) {
        alert("Frames must be a positive integer.");
        return false;
    }

    const raw = refsInput.value.trim();
    if (!raw) {
        alert("Please enter a reference string.");
        return false;
    }

    const parts = raw.replace(/,/g, " ").split(/\s+/);
    try {
        refList = parts.map((x) => parseInt(x, 10));
        if (refList.some((x) => isNaN(x))) throw new Error();
    } catch {
        alert("Reference string must contain only integers.");
        return false;
    }

    algo = algoSelect.value;
    prefetchEnabled = prefetchToggle ? prefetchToggle.checked : false;
    tutorMode = tutorToggle ? tutorToggle.checked : false;
    return true;
}

function hardResetState() {
    frames = Array(frameCount).fill(-1);
    stepIndex = 0;
    fifoQueue = [];
    lastUsed = {};
    pageFrequency = {};
    secondChanceBits = {};
    clockHand = 0;
    faults = 0;
    hits = 0;
    timelineEvents = [];
    chartData = [];
    viewStart = 0;
    viewEnd = null;

    if (statsChart) {
        statsChart.destroy();
        statsChart = null;
    }

    clearLog();
    updateStats();
    drawTable();
    updateTimeline();
    updateMemoryMap();
    updateStatsChart();
    const qp = $("quizPanel");
    if (qp) qp.innerHTML = "";

    const info = $("stepInfo");
    if (info) info.textContent = 'Ready. Click "Run All" or "Step" to start.';
}

// ---------- ALGORITHMS ----------
function fifoStep(page) {
    if (frames.includes(page)) {
        const idx = frames.indexOf(page);
        return { action: "HIT", frameIndex: idx, replaced: null };
    }
    let idx = frames.indexOf(-1);
    let replaced = null;
    if (idx !== -1) {
        frames[idx] = page;
    } else {
        replaced = fifoQueue.shift();
        idx = frames.indexOf(replaced);
        frames[idx] = page;
    }
    fifoQueue.push(page);
    return { action: "FAULT", frameIndex: idx, replaced };
}

function secondChanceStep(page) {
    if (frames.includes(page)) {
        const idx = frames.indexOf(page);
        secondChanceBits[page] = 1;
        return { action: "HIT", frameIndex: idx, replaced: null };
    }

    let idx = frames.indexOf(-1);
    let replaced = null;

    if (idx !== -1) {
        frames[idx] = page;
        secondChanceBits[page] = 0;
        return { action: "FAULT", frameIndex: idx, replaced: null };
    }

    let victimFrame = -1;
    let secondaryMsg = "";

    while (victimFrame === -1) {
        const currentPage = frames[clockHand];
        const rBit = secondChanceBits[currentPage] ?? 0;

        if (rBit === 0) {
            replaced = currentPage;
            victimFrame = clockHand;
            secondaryMsg = ` (R-bit 0, replacing ${replaced})`;
        } else {
            secondChanceBits[currentPage] = 0;
            secondaryMsg = ` (R-bit 1, cleared to 0, hand moved)`;
        }

        clockHand = (clockHand + 1) % frameCount;
    }

    frames[victimFrame] = page;
    secondChanceBits[page] = 0;

    return { action: "FAULT", frameIndex: victimFrame, replaced, secondaryMsg };
}

function lruStep(page, time) {
    if (frames.includes(page)) {
        const idx = frames.indexOf(page);
        lastUsed[page] = time;
        return { action: "HIT", frameIndex: idx, replaced: null };
    }

    let idx = frames.indexOf(-1);
    if (idx !== -1) {
        frames[idx] = page;
        lastUsed[page] = time;
        return { action: "FAULT", frameIndex: idx, replaced: null };
    }

    let lruPage = null;
    let minTime = Infinity;
    for (const f of frames) {
        const t = lastUsed[f] ?? -1;
        if (t < minTime) {
            minTime = t;
            lruPage = f;
        }
    }
    const pos = frames.indexOf(lruPage);
    const replaced = frames[pos];
    frames[pos] = page;
    lastUsed[page] = time;
    return { action: "FAULT", frameIndex: pos, replaced };
}

function lfuStep(page) {
    if (frames.includes(page)) {
        const idx = frames.indexOf(page);
        pageFrequency[page] = (pageFrequency[page] || 0) + 1;
        return { action: "HIT", frameIndex: idx, replaced: null };
    }

    let idx = frames.indexOf(-1);
    if (idx !== -1) {
        frames[idx] = page;
        pageFrequency[page] = (pageFrequency[page] || 0) + 1;
        return { action: "FAULT", frameIndex: idx, replaced: null };
    }

    let victim = null;
    let minFreq = Infinity;
    let oldestTime = Infinity;
    for (const f of frames) {
        const freq = pageFrequency[f] || 0;
        const lu = lastUsed[f] ?? -1;
        if (freq < minFreq || (freq === minFreq && lu < oldestTime)) {
            minFreq = freq;
            oldestTime = lu;
            victim = f;
        }
    }
    const pos = frames.indexOf(victim);
    const replaced = frames[pos];
    frames[pos] = page;
    pageFrequency[page] = (pageFrequency[page] || 0) + 1;
    return { action: "FAULT", frameIndex: pos, replaced };
}

function optimalStep(page, idx) {
    if (frames.includes(page)) {
        const posHit = frames.indexOf(page);
        return { action: "HIT", frameIndex: posHit, replaced: null };
    }

    let empty = frames.indexOf(-1);
    if (empty !== -1) {
        frames[empty] = page;
        return { action: "FAULT", frameIndex: empty, replaced: null };
    }

    const future = refList.slice(idx + 1);
    const positions = frames.map((f) => {
        const pos = future.indexOf(f);
        return pos === -1 ? Infinity : pos;
    });

    let maxPos = -1;
    let replaceIdx = -1;
    for (let i = 0; i < positions.length; i++) {
        if (positions[i] > maxPos) {
            maxPos = positions[i];
            replaceIdx = i;
        }
    }

    const replaced = frames[replaceIdx];
    frames[replaceIdx] = page;
    return { action: "FAULT", frameIndex: replaceIdx, replaced };
}

// ---------- PREFETCH ----------
function prefetchPrediction(currentIndex) {
    if (!prefetchEnabled) return;
    const nextIndex = currentIndex + 1;
    if (nextIndex >= refList.length) return;
    const nextPage = refList[nextIndex];

    addLogEvent({
        step: `${currentIndex + 1}→${nextIndex + 1}`,
        page: nextPage,
        action: "PREFETCH",
        frameIndex: null,
        replaced: null,
    });
}

// ---------- SIMULATION CONTROL ----------
function stepSimulation() {
    if (stepIndex >= refList.length) {
        const info = $("stepInfo");
        if (info) info.textContent = "Simulation finished.";
        generateQuiz();
        return;
    }

    const page = refList[stepIndex];
    let result;
    let secondaryMsg = null;

    if (algo === "FIFO") {
        result = fifoStep(page);
    } else if (algo === "LRU") {
        result = lruStep(page, stepIndex);
    } else if (algo === "LFU") {
        result = lfuStep(page);
    } else if (algo === "Second-Chance") {
        const scResult = secondChanceStep(page);
        result = scResult;
        secondaryMsg = scResult.secondaryMsg;
    } else {
        result = optimalStep(page, stepIndex);
    }

    if (result.action === "FAULT") faults++;
    else if (result.action === "HIT") hits++;

    pageFrequency[page] = (pageFrequency[page] || 0) + 1;
    lastUsed[page] = stepIndex;

    updateStats();

    const stepNo = stepIndex + 1;
    const info = $("stepInfo");
    if (info) {
        info.textContent = `Step ${stepNo} / ${refList.length} | Page ${page} | ${result.action}`;
    }

    addLogEvent({
        step: stepNo,
        page,
        action: result.action,
        frameIndex: result.frameIndex,
        replaced: result.replaced,
        secondaryMsg,
    });

    timelineEvents.push({ step: stepNo, page, action: result.action });
    updateTimeline();
    updateMemoryMap();
    prefetchPrediction(stepIndex);

    stepIndex++;
    drawTable(result.frameIndex);
}

function runSimulation() {
    if (!readInputs()) return;
    hardResetState();
    while (stepIndex < refList.length) {
        stepSimulation();
    }
}

// ---------- PURE SIMULATION ----------
function simulateAlgorithmPure(name, framesCount, refs) {
    let framesLocal = Array(framesCount).fill(-1);
    let fifoQ = [];
    let lastUsedLocal = {};
    let freqLocal = {};
    let scBitsLocal = {};
    let clockHandLocal = 0;
    let faultsLocal = 0;
    let hitsLocal = 0;

    for (let i = 0; i < refs.length; i++) {
        const page = refs[i];

        if (framesLocal.includes(page)) {
            hitsLocal++;
            if (name === "LRU" || name === "LFU") {
                lastUsedLocal[page] = i;
            }
            if (name === "LFU") {
                freqLocal[page] = (freqLocal[page] || 0) + 1;
            }
            if (name === "Second-Chance") {
                scBitsLocal[page] = 1;
            }
            continue;
        }

        faultsLocal++;

        let idx = framesLocal.indexOf(-1);
        if (idx !== -1) {
            framesLocal[idx] = page;
            if (name === "FIFO") fifoQ.push(page);
            if (name === "LRU" || name === "LFU") lastUsedLocal[page] = i;
            if (name === "LFU") freqLocal[page] = (freqLocal[page] || 0) + 1;
            if (name === "Second-Chance") scBitsLocal[page] = 0;
            continue;
        }

        if (name === "FIFO") {
            const removed = fifoQ.shift();
            idx = framesLocal.indexOf(removed);
            framesLocal[idx] = page;
            fifoQ.push(page);
        } else if (name === "LRU") {
            let lruPage = null;
            let minTime = Infinity;
            for (const f of framesLocal) {
                const t = lastUsedLocal[f] ?? -1;
                if (t < minTime) {
                    minTime = t;
                    lruPage = f;
                }
            }
            const pos = framesLocal.indexOf(lruPage);
            framesLocal[pos] = page;
            lastUsedLocal[page] = i;
        } else if (name === "LFU") {
            let victim = null;
            let minFreq = Infinity;
            let oldestTime = Infinity;
            for (const f of framesLocal) {
                const freq = freqLocal[f] || 0;
                const lu = lastUsedLocal[f] ?? -1;
                if (freq < minFreq || (freq === minFreq && lu < oldestTime)) {
                    minFreq = freq;
                    oldestTime = lu;
                    victim = f;
                }
            }
            const pos = framesLocal.indexOf(victim);
            framesLocal[pos] = page;
            freqLocal[page] = (freqLocal[page] || 0) + 1;
            lastUsedLocal[page] = i;
        } else if (name === "Second-Chance") {
            let victimFrame = -1;
            let iterations = 0;
            while (victimFrame === -1 && iterations < framesCount * 2) {
                const currentPage = framesLocal[clockHandLocal];
                const rBit = scBitsLocal[currentPage] ?? 0;
                if (rBit === 0) {
                    victimFrame = clockHandLocal;
                } else {
                    scBitsLocal[currentPage] = 0;
                }
                clockHandLocal = (clockHandLocal + 1) % framesCount;
                iterations++;
            }
            framesLocal[victimFrame] = page;
            scBitsLocal[page] = 0;
        } else if (name === "Optimal") {
            const future = refs.slice(i + 1);
            const positions = framesLocal.map((f) => {
                const pos = future.indexOf(f);
                return pos === -1 ? Infinity : pos;
            });
            let maxPos = -1;
            let replaceIdx = -1;
            for (let j = 0; j < positions.length; j++) {
                if (positions[j] > maxPos) {
                    maxPos = positions[j];
                    replaceIdx = j;
                }
            }
            framesLocal[replaceIdx] = page;
        }
    }

    return { faults: faultsLocal, hits: hitsLocal };
}

function compareAlgorithms() {
    if (!readInputs()) return;
    const table = $("compareTable");
    if (!table) return;

    const algos = ["FIFO", "LRU", "LFU", "Second-Chance", "Optimal"];
    const results = {};
    let maxFaults = 0;
    let maxHits = 0;

    for (const a of algos) {
        const res = simulateAlgorithmPure(a, frameCount, refList);
        results[a] = res;
        maxFaults = Math.max(maxFaults, res.faults);
        maxHits = Math.max(maxHits, res.hits);
    }

    let html =
        "<tr><th>Algorithm</th><th>Page Faults</th><th>Hits</th><th>Faults (visual)</th><th>Hits (visual)</th></tr>";

    for (const a of algos) {
        const { faults, hits } = results[a];
        const faultWidth = maxFaults === 0 ? 0 : (faults / maxFaults) * 100;
        const hitWidth = maxHits === 0 ? 0 : (hits / maxHits) * 100;

        html += `
        <tr>
          <td>${a}</td>
          <td>${faults}</td>
          <td>${hits}</td>
          <td class="bar-cell">
            <div class="bar-wrapper">
              <div class="bar fault" style="width:${faultWidth || 4}%"></div>
            </div>
          </td>
          <td class="bar-cell">
            <div class="bar-wrapper">
              <div class="bar hit" style="width:${hitWidth || 4}%"></div>
            </div>
          </td>
        </tr>`;
    }

    table.innerHTML = html;
}

// ---------- FAULTS VS FRAMES + BELADY ----------
// ---------- FAULTS VS FRAMES + BELADY ----------
// function drawSimpleChart(results) {
//     const chartDiv = $("faultFramesChart");
//     if (!chartDiv) return;

//     if (!results || !results.length) {
//         chartDiv.innerHTML =
//             "<p class='muted small-text'>No data to display. Run analysis first.</p>";
//         return;
//     }

//     chartDiv.innerHTML =
//         '<h3>Faults vs Frames Chart</h3><div id="barContainer"></div>';

//     const container = $("barContainer");
//     if (!container) return;

//     container.style.display = "flex";
//     container.style.alignItems = "flex-end";
//     container.style.height = "150px";
//     container.style.borderLeft = "1px solid #9ca3af";
//     container.style.borderBottom = "1px solid #9ca3af";
//     container.style.paddingLeft = "5px";

//     let maxFault = results.reduce((m, r) => Math.max(m, r.faults), 0) || 1;

//     results.forEach((row) => {
//         const height = (row.faults / maxFault) * 100;

//         const bar = document.createElement("div");
//         bar.className = "chart-bar fault";
//         bar.style.height = `${height}%`;
//         bar.style.width = `calc(${100 / results.length}% - 4px)`;
//         bar.style.margin = "0 2px";
//         bar.title = `Frames: ${row.frames}, Faults: ${row.faults}`;

//         const label = document.createElement("span");
//         label.className = "chart-label small-text";
//         label.textContent = row.frames;

//         const wrapper = document.createElement("div");
//         wrapper.style.display = "flex";
//         wrapper.style.flexDirection = "column";
//         wrapper.style.alignItems = "center";

//         wrapper.appendChild(bar);
//         wrapper.appendChild(label);
//         container.appendChild(wrapper);
//     });
// }


function generateFaultsVsFrames() {
    if (!readInputs()) return;

    const maxFramesInput = $("maxFrames");
    const table = $("faultFramesTable");
    const anomalyDiv = $("beladyAnomaly");
    if (!maxFramesInput || !table || !anomalyDiv) return;

    let maxF = parseInt(maxFramesInput.value || "0", 10);
    if (isNaN(maxF) || maxF <= 0) {
        alert("Please enter a valid maximum number of frames.");
        return;
    }

    const algoName = algo;
    const results = [];
    let maxFault = 0;
    let anomalyDetected = false;
    let previousFaults = Infinity;

    for (let f = 1; f <= maxF; f++) {
        const res = simulateAlgorithmPure(algoName, f, refList);
        if (f > 1 && res.faults > previousFaults) {
            anomalyDetected = true;
        }
        results.push({ frames: f, faults: res.faults });
        maxFault = Math.max(maxFault, res.faults);
        previousFaults = res.faults;
    }

    if (algoName === "FIFO" && anomalyDetected) {
        const anomalyRowIndex = results.findIndex(
            (r, i) => i > 0 && r.faults > results[i - 1].faults
        );
        const anomalyRow = results[anomalyRowIndex];
        anomalyDiv.innerHTML = `<span style="color:#ef4444; font-weight:bold;">⚠️ Belady's Anomaly Detected:</span> Faults increased at Frames ${anomalyRow.frames} (${anomalyRow.faults} faults).`;
    } else if (algoName === "FIFO") {
        anomalyDiv.textContent = `No Belady's Anomaly detected for FIFO up to ${maxF} frames.`;
    } else {
        anomalyDiv.textContent = `Belady's Anomaly is specific to FIFO. ${algoName} does not exhibit it here.`;
    }

    let html =
        "<tr><th>Frames</th><th>Page Faults</th><th>Faults (visual)</th></tr>";

    results.forEach((row) => {
        const width = maxFault === 0 ? 0 : Math.max(4, (row.faults / maxFault) * 100);
        html += `
        <tr data-frames="${row.frames}">
          <td>${row.frames}</td>
          <td>${row.faults}</td>
          <td class="bar-cell">
            <div class="bar-wrapper">
              <div class="bar fault" style="width:${width}%"></div>
            </div>
          </td>
        </tr>`;
    });

    table.innerHTML = html;
    drawSimpleChart(results);

    const rows = table.querySelectorAll("tr[data-frames]");
    rows.forEach((tr) => {
        tr.addEventListener("click", () => {
            const f = parseInt(tr.getAttribute("data-frames"), 10);
            const framesInput = $("frames");
            if (!framesInput) return;
            framesInput.value = String(f);
            runSimulation();
            if (window.gsap && window.ScrollToPlugin) {
                gsap.to(window, { duration: 0.5, scrollTo: "#simulator" });
            }
        });
    });
}

// ---------- CHART.JS HIT-RATIO CHART ----------
function updateStatsChart() {
    const canvas = $("statsChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (!chartData.length) {
        if (statsChart) {
            statsChart.destroy();
            statsChart = null;
        }
        return;
    }

    const labels = chartData.map(d => d.step + 1);
    const hitRatios = chartData.map(d => d.ratio);

    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "rgba(34,197,94,0.45)");
    gradient.addColorStop(1, "rgba(34,197,94,0)");

    if (!statsChart) {
        statsChart = new Chart(ctx, {
            type: "line",
            data: {
                labels,
                datasets: [
                    {
                        label: "Hit Ratio",
                        data: hitRatios,
                        fill: true,
                        backgroundColor: gradient,
                        borderColor: "#22c55e",
                        borderWidth: 2,
                        tension: 0.35,
                        pointRadius: 3,
                        pointHoverRadius: 5,
                        pointBackgroundColor: "#22c55e",
                        pointBorderColor: "#0f172a",
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: "index",
                    intersect: false,
                },
                plugins: {
                    legend: {
                        display: false,
                    },
                    tooltip: {
                        backgroundColor: "rgba(15,23,42,0.95)",
                        titleColor: "#e5e7eb",
                        bodyColor: "#e5e7eb",
                        borderColor: "rgba(148,163,184,0.7)",
                        borderWidth: 1,
                        padding: 8,
                        displayColors: false,
                        callbacks: {
                            title(items) {
                                const i = items[0].dataIndex;
                                const d = chartData[i];
                                return `Step ${d.step + 1}`;
                            },
                            label(item) {
                                const d = chartData[item.dataIndex];
                                const hitR = d.ratio.toFixed(2);
                                return [
                                    `Hit Ratio: ${hitR}`,
                                    `Hits: ${d.hits}, Faults: ${d.faults}`,
                                ];
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        ticks: {
                            color: "#9ca3af",
                            maxRotation: 0,
                        },
                        grid: {
                            color: "rgba(55,65,81,0.5)",
                        },
                    },
                    y: {
                        min: 0,
                        max: 1,
                        ticks: {
                            color: "#9ca3af",
                            callback: (v) => v.toFixed(1),
                        },
                        grid: {
                            color: "rgba(55,65,81,0.5)",
                        },
                    },
                },
            },
        });
    } else {
        statsChart.data.labels = labels;
        statsChart.data.datasets[0].data = hitRatios;
        statsChart.update();
    }
}

// ---------- QUIZ ----------
// ---------- VIVA NOTES GENERATOR ----------
function generateQuiz() {
    const panel = $("quizPanel");
    if (!panel) return;
    panel.innerHTML = "";

    const total = faults + hits;
    if (total === 0) {
        panel.innerHTML =
            "<p class='muted'>Run a simulation first to generate observation notes.</p>";
        return;
    }

    const hitRatio = total === 0 ? 0 : hits / total;
    const faultRate = total === 0 ? 0 : faults / total;

    const header = document.createElement("h3");
    header.textContent = "Auto-Generated Observation Notes";
    panel.appendChild(header);

    const p1 = document.createElement("p");
    p1.innerHTML = `<b>Algorithm Used:</b> ${algo} with <b>${frameCount}</b> frames and reference string of length <b>${refList.length}</b>.`;
    panel.appendChild(p1);

    const p2 = document.createElement("p");
    p2.innerHTML = `<b>Performance Summary:</b> Total Page Faults = <b>${faults}</b>, Hits = <b>${hits}</b>, Hit Ratio = <b>${hitRatio.toFixed(
        2
    )}</b>, Fault Rate = <b>${(faultRate * 100).toFixed(1)}%</b>.`;
    panel.appendChild(p2);

    const algosForComparison = ["FIFO", "LRU", "LFU", "Second-Chance", "Optimal"];
    const results = algosForComparison.map((a) =>
        simulateAlgorithmPure(a, frameCount, refList)
    );
    const minFaults = Math.min(...results.map((r) => r.faults));
    const bestAlgo =
        algosForComparison[results.findIndex((r) => r.faults === minFaults)];

    const p3 = document.createElement("p");
    p3.innerHTML = `<b>Relative Behaviour:</b> For this workload, the best performing algorithm (lowest faults) is <b>${bestAlgo}</b> with <b>${minFaults}</b> faults. This point can be used directly in viva to justify why some algorithms are more efficient for a given pattern.`;
    panel.appendChild(p3);

    const listTitle = document.createElement("p");
    listTitle.innerHTML = "<b>Viva Notes (you can speak like this):</b>";
    panel.appendChild(listTitle);

    const ul = document.createElement("ul");
    ul.style.marginLeft = "16px";
    ul.style.fontSize = "0.85rem";

    const li1 = document.createElement("li");
    li1.textContent = `For the given reference string, ${algo} produced ${faults} faults and a hit ratio of ${hitRatio.toFixed(
        2
    )}.`;

    const li2 = document.createElement("li");
    li2.textContent = `When we compare all algorithms on the same input, ${bestAlgo} gives the minimum number of page faults.`;

    const li3 = document.createElement("li");
    li3.textContent = `This shows how page replacement policy and number of frames directly impact overall performance of virtual memory.`;

    ul.appendChild(li1);
    ul.appendChild(li2);
    ul.appendChild(li3);
    panel.appendChild(ul);

    if (window.gsap) {
        gsap.from(panel.children, {
            opacity: 0,
            y: 10,
            stagger: 0.08,
            duration: 0.5,
        });
    }
}


// ---------- DOWNLOAD REPORT ----------
function downloadReport() {
    if (!refList.length) {
        if (!readInputs()) return;
    }

    let report = "Virtual Memory Simulation Summary\n";
    report += "-----------------------------------\n\n";
    report += `Algorithm: ${algo}\n`;
    report += `Frames: ${frameCount}\n`;
    report += `Reference String: ${refList.join(" ")}\n\n`;
    report += `Total Page Faults: ${faults}\n`;
    report += `Total Hits: ${hits}\n`;
    const total = faults + hits;
    const ratio = total === 0 ? 0 : hits / total;
    const faultRate = total === 0 ? 0 : faults / total;
    report += `Hit Ratio: ${ratio.toFixed(2)}\n`;
    report += `Fault Rate: ${(faultRate * 100).toFixed(1)}%\n\n`;

    report += "Final Frame Table:\n";
    frames.forEach((f, i) => {
        report += `F${i}: ${f === -1 ? "-" : f}\n`;
    });

    report += "\nPage Statistics:\n";
    const uniquePages = Array.from(new Set(refList));
    uniquePages.forEach((p) => {
        const inRam = frames.includes(p) ? "In RAM" : "Not in RAM";
        const freq = pageFrequency[p] || 0;
        const lu = lastUsed[p] === undefined ? "-" : lastUsed[p];
        report += `Page ${p}: ${inRam}, Count=${freq}, LastUsed=${lu}\n`;
    });

    const blob = new Blob([report], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "vm_summary.txt";
    a.click();
    URL.revokeObjectURL(url);
}

// ---------- PRESET SCENARIOS ----------
function applyScenario(type) {
    const framesInput = $("frames");
    const refsInput = $("refs");
    const algoSelect = $("algo");
    if (!framesInput || !refsInput || !algoSelect) return;

    if (type === "textbook") {
        framesInput.value = "3";
        refsInput.value =
            "7 0 1 2 0 3 0 4 2 3 0 3 2 1 2 0 1 7 0 1";
        algoSelect.value = "LRU";
    } else if (type === "locality") {
        framesInput.value = "4";
        refsInput.value = "1 2 1 2 1 3 1 2 1 2 3 1 2 1 2";
        algoSelect.value = "LRU";
    } else if (type === "random") {
        const framesRand = Math.floor(Math.random() * 3) + 3;
        framesInput.value = String(framesRand);
        const pages = [];
        for (let i = 0; i < 20; i++) {
            pages.push(Math.floor(Math.random() * 8));
        }
        refsInput.value = pages.join(" ");
        algoSelect.value = "FIFO";
    } else if (type === "belady") {
        framesInput.value = "3";
        refsInput.value = "1 2 3 4 1 2 5 1 2 3 4 5";
        algoSelect.value = "FIFO";
    }

    readInputs();
    hardResetState();
    compareAlgorithms();

    const targetSection = type === "belady" ? "#faultExplorer" : "#comparison";
    if (window.gsap && window.ScrollToPlugin) {
        gsap.to(window, { duration: 0.8, scrollTo: targetSection });
    }
}

// ---------- INIT ----------
window.addEventListener("DOMContentLoaded", () => {
    if (window.gsap && window.ScrollTrigger && window.ScrollToPlugin) {
        gsap.registerPlugin(ScrollTrigger, ScrollToPlugin);
    } else if (window.gsap && window.ScrollTrigger) {
        gsap.registerPlugin(ScrollTrigger);
    }

    readInputs();
    hardResetState();
    drawTable();

    const runBtn = $("runBtn");
    const stepBtn = $("stepBtn");
    const resetBtn = $("resetBtn");
    const compareBtn = $("compareBtn");
    const downloadBtn = $("downloadBtn");
    const faultExplorerBtn = $("faultExplorerBtn");
    const algoSelect = $("algo");

    const scTextbook = $("scenarioTextbook");
    const scLocality = $("scenarioLocality");
    const scRandom = $("scenarioRandom");
    const scBelady = $("scenarioBelady");

    if (scTextbook) scTextbook.addEventListener("click", () => applyScenario("textbook"));
    if (scLocality) scLocality.addEventListener("click", () => applyScenario("locality"));
    if (scRandom) scRandom.addEventListener("click", () => applyScenario("random"));
    if (scBelady) scBelady.addEventListener("click", () => applyScenario("belady"));

    if (runBtn) runBtn.addEventListener("click", runSimulation);
    if (stepBtn)
        stepBtn.addEventListener("click", () => {
            if (!refList.length) {
                if (!readInputs()) return;
                hardResetState();
            } else {
                readInputs();
            }
            stepSimulation();
        });
    if (resetBtn)
        resetBtn.addEventListener("click", () => {
            readInputs();
            hardResetState();
        });
    if (compareBtn) compareBtn.addEventListener("click", compareAlgorithms);
    if (downloadBtn) downloadBtn.addEventListener("click", downloadReport);
    if (faultExplorerBtn)
        faultExplorerBtn.addEventListener("click", generateFaultsVsFrames);

    const prefetchToggle = $("prefetchToggle");
    const tutorToggle = $("tutorModeToggle");
    if (prefetchToggle) prefetchToggle.addEventListener("change", readInputs);
    if (tutorToggle) tutorToggle.addEventListener("change", readInputs);

    if (algoSelect)
        algoSelect.addEventListener("change", () => {
            readInputs();
            drawTable();
        });

    const cards = document.querySelectorAll(".fade-card");
    if (window.gsap && window.ScrollTrigger) {
        cards.forEach((card) => {
            gsap.fromTo(
                card,
                { opacity: 0, y: 30 },
                {
                    opacity: 1,
                    y: 0,
                    duration: 0.8,
                    ease: "power2.out",
                    scrollTrigger: {
                        trigger: card,
                        start: "top bottom-=100",
                        toggleActions: "play none none none",
                    },
                }
            );
        });
    } else {
        cards.forEach((c) => (c.style.opacity = 1));
    }

    const header = document.querySelector(".page header");
    if (header && window.gsap) {
        gsap.from(header, {
            opacity: 0,
            y: -15,
            duration: 0.7,
            ease: "power2.out",
        });
    }
});
// I am here for one more commit and just learning making branches and merging it
// Removed one section which only making the project bulky, and the section is only descriptive 
