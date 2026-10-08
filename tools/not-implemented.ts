/** Stub for root scripts whose implementation belongs to a later task. Usage: node tools/not-implemented.ts <script> <T-xxx> */
const [script = 'script', task = 'T-???'] = process.argv.slice(2);
console.log(`${script}: not yet implemented (${task})`);
