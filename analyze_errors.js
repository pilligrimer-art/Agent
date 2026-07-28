const fs = require('fs');
const path = require('path');

function analyzeLog(logPath, description) {
    if (!fs.existsSync(logPath)) {
        console.log(`[!] Log file not found: ${logPath}`);
        return;
    }
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim());
    const events = {};
    let totalCycles = 0;
    
    lines.forEach(l => {
        const m = l.match(/\[([^\]]+)\]\s+\[([^\]]+)\]/);
        if (m) {
            const ev = m[2];
            events[ev] = (events[ev] || 0) + 1;
            if (ev === 'actions.parsed_total') totalCycles++;
        }
    });

    if (totalCycles === 0) {
        console.log(`[!] No cycles recorded in ${logPath} yet.`);
        return;
    }

    const malformed = events['parser.malformed_intent'] || 0;
    const hallRepaired = events['parser.hallucination_repaired'] || 0;
    const hallHint = events['parser.hallucination_hint'] || 0;
    const loopDetected = events['agent.loop_detected'] || 0;
    const silentMem = events['parser.silent_mem_detected'] || 0;
    const compositeErrors = malformed + hallHint + silentMem;

    console.log(`\n=== ${description.toUpperCase()} ===`);
    console.log(`Total cycles: ${totalCycles}`);
    console.log(`Malformed intents:      ${malformed} (${(malformed/totalCycles*100).toFixed(1)}%)`);
    console.log(`Hallucinations (auto):  ${hallRepaired} (${(hallRepaired/totalCycles*100).toFixed(1)}%)`);
    console.log(`Hallucinations (hint):  ${hallHint} (${(hallHint/totalCycles*100).toFixed(1)}%)`);
    console.log(`Silent MEM tags:        ${silentMem} (${(silentMem/totalCycles*100).toFixed(1)}%)`);
    console.log(`Loop detections:        ${loopDetected} (${(loopDetected/totalCycles*100).toFixed(1)}%)`);
    console.log(`-----------------------------------`);
    console.log(`COMPOSITE ERROR RATE:   ${compositeErrors}/${totalCycles} = ${(compositeErrors/totalCycles*100).toFixed(1)}%`);
}

console.log('--- ERROR RATE COMPARISON ---');
analyzeLog(path.join(__dirname, 'logs', 'parse_errors.log'), 'Production (gemma3:4b)');
analyzeLog(path.join(__dirname, 'logs_pilot', 'parse_errors.log'), 'Pilot (qwen3.5:9b)');
