import { spawn } from 'node:child_process'
const port = String(process.env.VITE_PORT ?? '5199')
const vite = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', port], { stdio: 'inherit', shell: true })
await new Promise(resolve => setTimeout(resolve, 1200))
const electron = spawn('npx', ['electron', '.'], { stdio: 'inherit', shell: true, env: { ...process.env, VITE_DEV_SERVER_URL: `http://127.0.0.1:${port}` } })
electron.on('exit', code => { vite.kill(); process.exit(code ?? 0) })
process.on('SIGINT', () => { electron.kill(); vite.kill() })
