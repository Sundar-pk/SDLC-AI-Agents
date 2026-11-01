import { spawnSync } from 'node:child_process';
const r = spawnSync(process.execPath, ['--test'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
