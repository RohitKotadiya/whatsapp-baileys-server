const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys")
const express = require("express")
const QRCode = require("qrcode")
const pino = require("pino")
const fs = require("fs")

const app = express()
app.use(express.json())

const API_SECRET = process.env.API_SECRET
const QR_SECRET = process.env.QR_SECRET

if (!API_SECRET) {
  console.error("ERROR: API_SECRET env var is required")
  process.exit(1)
}

const logger = pino({ level: "silent" })

// sessions: Map<sessionId, { sock, status, latestQR }>
const sessions = new Map()

async function connectSession(sessionId) {
  console.log(`[${sessionId}] Connecting...`)

  const existing = sessions.get(sessionId) || {}
  const sessionData = { ...existing, status: "connecting", latestQR: null }
  sessions.set(sessionId, sessionData)

  const { state, saveCreds } = await useMultiFileAuthState(`./auth_info/${sessionId}`)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["AFM POS", "Chrome", "1.0.0"],
  })
  sessionData.sock = sock

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      sessionData.latestQR = await QRCode.toDataURL(qr)
      sessionData.status = "qr_pending"
      console.log(`[${sessionId}] QR ready`)
    }

    if (connection === "close") {
      sessionData.latestQR = null
      sessionData.status = "disconnected"
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log(`[${sessionId}] Disconnected. Code: ${statusCode}. Reconnect: ${shouldReconnect}`)
      if (shouldReconnect) {
        setTimeout(() => connectSession(sessionId), 3000)
      } else {
        // Logged out from phone — delete stale creds so next QR scan starts fresh
        const authDir = `./auth_info/${sessionId}`
        if (fs.existsSync(authDir)) {
          fs.rmSync(authDir, { recursive: true, force: true })
          console.log(`[${sessionId}] Auth files cleared after logout`)
        }
        sessions.delete(sessionId)
      }
    } else if (connection === "open") {
      sessionData.latestQR = null
      sessionData.status = "connected"
      console.log(`[${sessionId}] Connected!`)
    }
  })

  sock.ev.on("creds.update", saveCreds)
}

// On startup, restore all existing sessions from auth_info/
async function restoreExistingSessions() {
  const authDir = "./auth_info"
  if (!fs.existsSync(authDir)) return
  const entries = fs.readdirSync(authDir)
  for (const entry of entries) {
    if (fs.statSync(`${authDir}/${entry}`).isDirectory()) {
      console.log(`Restoring session: ${entry}`)
      await connectSession(entry)
    }
  }
}

function requireApiKey(req, res, next) {
  if (req.headers["x-api-key"] !== API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" })
  }
  next()
}

// GET /qr?session=STORE_ID&secret=QR_SECRET
// Each store scans their own QR here once
app.get("/qr", async (req, res) => {
  if (QR_SECRET && req.query.secret !== QR_SECRET) {
    return res.status(401).send("Unauthorized")
  }

  const sessionId = req.query.session
  if (!sessionId) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;padding:20px">
        <h2>Missing session ID</h2>
        <p>Usage: <code>/qr?session=YOUR_STORE_ID&secret=QR_SECRET</code></p>
        <h3>Active sessions:</h3>
        <ul>${[...sessions.entries()].map(([id, d]) => `<li><strong>${id}</strong>: ${d.status}</li>`).join("") || "<li>None</li>"}</ul>
      </body></html>
    `)
  }

  const existing = sessions.get(sessionId)
  if (!existing || existing.status === "disconnected") {
    await connectSession(sessionId)
  }

  const session = sessions.get(sessionId)

  if (session.status === "connected") {
    return res.send(`
      <html><body style="text-align:center;font-family:sans-serif;padding:20px">
        <h2 style="color:green">✓ WhatsApp Connected!</h2>
        <p>Session: <strong>${sessionId}</strong></p>
      </body></html>
    `)
  }

  if (!session.latestQR) {
    return res.send(`
      <html><body style="text-align:center;font-family:sans-serif;padding:20px">
        <h2>Waiting for QR...</h2>
        <p>Session: <strong>${sessionId}</strong> — Status: ${session.status}</p>
        <script>setTimeout(() => location.reload(), 3000)</script>
      </body></html>
    `)
  }

  res.send(`
    <html><body style="text-align:center;font-family:sans-serif;padding:20px">
      <h2>Scan with WhatsApp</h2>
      <p>Session: <strong>${sessionId}</strong></p>
      <img src="${session.latestQR}" style="width:300px;height:300px" />
      <p>Open WhatsApp → Linked Devices → Link a Device</p>
      <p style="color:#888;font-size:12px">Auto-refreshes every 5s</p>
      <script>setTimeout(() => location.reload(), 5000)</script>
    </body></html>
  `)
})

// GET /status — all sessions or ?session=STORE_ID
app.get("/status", requireApiKey, (req, res) => {
  const sessionId = req.query.session
  if (sessionId) {
    const session = sessions.get(sessionId)
    return res.json({ session: sessionId, status: session?.status || "not_found" })
  }
  const all = {}
  sessions.forEach((data, id) => { all[id] = data.status })
  res.json({ sessions: all })
})

// POST /send — { sessionId, to, message }
app.post("/send", requireApiKey, async (req, res) => {
  const { sessionId, to, message } = req.body

  if (!sessionId || !to || !message) {
    return res.status(400).json({ error: "sessionId, to, and message are required" })
  }

  const session = sessions.get(sessionId)

  if (!session || session.status !== "connected") {
    return res.status(503).json({
      error: "WhatsApp not connected for this session",
      status: session?.status || "not_found",
      hint: `Visit /qr?session=${sessionId} to connect`,
    })
  }

  try {
    const cleanNumber = String(to).replace(/^(\+91|91)/, "").replace(/\s+/g, "")
    const jid = `91${cleanNumber}@s.whatsapp.net`
    await session.sock.sendMessage(jid, { text: message })
    res.json({ success: true })
  } catch (err) {
    console.error(`[${sessionId}] Send error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

const PORT = process.env.PORT || 8080
app.listen(PORT, () => {
  console.log(`Baileys multi-session server running on port ${PORT}`)
  restoreExistingSessions()
})
