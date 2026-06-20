const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys")
const express = require("express")
const QRCode = require("qrcode")
const pino = require("pino")

const app = express()
app.use(express.json())

const API_SECRET = process.env.API_SECRET
const QR_SECRET = process.env.QR_SECRET

if (!API_SECRET) {
  console.error("ERROR: API_SECRET env var is required")
  process.exit(1)
}

let sock = null
let latestQR = null
let connectionStatus = "disconnected" // "disconnected" | "connecting" | "qr_pending" | "connected"

const logger = pino({ level: "silent" })

async function connectToWhatsApp() {
  connectionStatus = "connecting"
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info")
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: true,
    browser: ["AFM POS", "Chrome", "1.0.0"],
  })

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      latestQR = await QRCode.toDataURL(qr)
      connectionStatus = "qr_pending"
      console.log("QR code ready — visit /qr to scan")
    }

    if (connection === "close") {
      latestQR = null
      connectionStatus = "disconnected"
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      console.log("Connection closed. Reason:", statusCode, "| Reconnecting:", shouldReconnect)
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000)
      }
    } else if (connection === "open") {
      latestQR = null
      connectionStatus = "connected"
      console.log("WhatsApp connected!")
    }
  })

  sock.ev.on("creds.update", saveCreds)
}

// Middleware: API key required
function requireApiKey(req, res, next) {
  if (req.headers["x-api-key"] !== API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" })
  }
  next()
}

// GET /qr — scan QR code (protected by ?secret=QR_SECRET)
app.get("/qr", (req, res) => {
  if (QR_SECRET && req.query.secret !== QR_SECRET) {
    return res.status(401).send("Unauthorized")
  }

  if (connectionStatus === "connected") {
    return res.send("<html><body><h2 style='color:green'>✓ WhatsApp is connected!</h2></body></html>")
  }

  if (!latestQR) {
    return res.send(`<html><body>
      <h2>Status: ${connectionStatus}</h2>
      <p>QR not ready yet. Refresh in a few seconds.</p>
      <script>setTimeout(() => location.reload(), 3000)</script>
    </body></html>`)
  }

  res.send(`<html><body style="text-align:center;font-family:sans-serif;padding:20px">
    <h2>Scan with WhatsApp</h2>
    <img src="${latestQR}" style="width:300px;height:300px" />
    <p>Open WhatsApp → Linked Devices → Link a Device</p>
    <p style="color:#888;font-size:12px">Page auto-refreshes every 5s</p>
    <script>setTimeout(() => location.reload(), 5000)</script>
  </body></html>`)
})

// GET /status
app.get("/status", requireApiKey, (req, res) => {
  res.json({ status: connectionStatus })
})

// POST /send — { to: "9876543210", message: "..." }
app.post("/send", requireApiKey, async (req, res) => {
  const { to, message } = req.body

  if (!to || !message) {
    return res.status(400).json({ error: "to and message are required" })
  }

  if (connectionStatus !== "connected") {
    return res.status(503).json({ error: "WhatsApp not connected", status: connectionStatus })
  }

  try {
    const cleanNumber = String(to).replace(/^(\+91|91)/, "").replace(/\s+/g, "")
    const jid = `91${cleanNumber}@s.whatsapp.net`
    await sock.sendMessage(jid, { text: message })
    res.json({ success: true })
  } catch (err) {
    console.error("Send error:", err.message)
    res.status(500).json({ error: err.message })
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`Baileys server running on port ${PORT}`)
  connectToWhatsApp()
})
