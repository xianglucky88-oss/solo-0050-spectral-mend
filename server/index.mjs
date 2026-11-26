import { createApp } from './app.mjs'

const port = Number(process.env.PORT ?? 4813)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 超出有效范围。')
createApp().listen(port, '127.0.0.1', () => {
  console.log(`工作台已启动 http://127.0.0.1:${port}`)
})
