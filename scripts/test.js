import {spawn} from 'node:child_process';
import app from '../src/app.js';
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const child=spawn(process.execPath,['--test','test/backend.test.js','test/user-panel.test.js','test/user-panel-sql.test.js'],{stdio:'inherit',env:{...process.env,TEST_BASE_URL:`http://127.0.0.1:${server.address().port}`}});
const code=await new Promise(resolve=>child.once('exit',resolve));
server.closeAllConnections();await new Promise(resolve=>server.close(resolve));process.exitCode=code??1;
