#!/usr/bin/env node
/**
 * muse-server.mjs
 * ------------------------------------------------------------------
 * MCP (stdio) server exposing Meta Muse (muse.ai) as tools, by driving
 * the real logged-in Chrome via playwright-core. See muse-driver.mjs for
 * the protocol rationale (Muse chat = encrypted "noise" WebSocket).
 *
 * Tools:
 *   muse_status    - browser / login / composer state
 *   muse_login     - open muse.ai and wait for Meta sign-in to complete
 *   muse_new_chat  - start a fresh thread
 *   muse_chat      - send a prompt, wait for the reply, return text
 *   muse_read_last - read the latest assistant message
 *   muse_dump_dom  - diagnostics: transcript HTML + element counts
 *   muse_close     - close the browser
 *
 * Config (env):
 *   MUSE_PROFILE_DIR   dedicated Chrome profile (default: ./.muse-profile)
 *   MUSE_URL           app URL (default https://muse.ai/)
 *   MUSE_HEADLESS=1    run headless (login must be done beforehand)
 *   MUSE_CHANNEL       chrome | msedge   (default chrome)
 * ------------------------------------------------------------------
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { driver } from './muse-driver.mjs'
import { startShim } from './muse-openai-shim.mjs'

const log = (...a) => console.error('[muse-mcp]', ...a)
const asText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] })
const wrap = (fn) => async (args) => {
  try {
    return asText(await fn(args || {}))
  } catch (err) {
    log('tool error:', err && err.message)
    return { isError: true, content: [{ type: 'text', text: `Muse error: ${err && err.message ? err.message : String(err)}` }] }
  }
}

export function buildServer() {
  const server = new McpServer({ name: 'muse', version: '0.1.0' })

  server.registerTool(
    'muse_status',
    {
      title: 'Muse status',
      description: 'Report whether the Muse browser is running, whether you are logged in to muse.ai, and whether the chat composer is ready.',
      inputSchema: {},
    },
    wrap(async () => driver.status()),
  )

  server.registerTool(
    'muse_login',
    {
      title: 'Muse login',
      description: 'Open muse.ai in the dedicated Chrome window and wait for Meta sign-in to complete. Use when muse_status reports loggedIn=false.',
      inputSchema: {
        timeout_sec: z.number().int().positive().max(900).optional().describe('How long to wait for login (default 300).'),
      },
    },
    wrap(async ({ timeout_sec }) => driver.login((timeout_sec || 300) * 1000)),
  )

  server.registerTool(
    'muse_new_chat',
    {
      title: 'Muse new chat',
      description: 'Start a fresh Muse thread (navigates to the home composer).',
      inputSchema: {},
    },
    wrap(async () => driver.newChat()),
  )

  server.registerTool(
    'muse_chat',
    {
      title: 'Chat with Muse',
      description: 'Send a prompt to Muse and return the assistant reply once streaming finishes. Uses your own logged-in session and token quota.',
      inputSchema: {
        prompt: z.string().optional().describe('The message to send. May be empty when attaching files.'),
        timeout_sec: z.number().int().positive().max(1800).optional().describe('Max seconds to wait for the reply (default 240).'),
        new_thread: z.boolean().optional().describe('Start a new thread before sending (default false = continue current thread).'),
        files: z.array(z.string()).optional().describe('Absolute paths or URLs of images/videos/files to attach to the message.'),
        chat: z.union([z.string(), z.number()]).optional().describe('Target chat by title, index, thread URL, or thread id (default: main chat).'),
      },
    },
    wrap(async ({ prompt, timeout_sec, new_thread, files, chat }) =>
      driver.chat(prompt || '', { timeoutMs: (timeout_sec || 240) * 1000, newThread: !!new_thread, files, chat }),
    ),
  )

  server.registerTool(
    'muse_read_last',
    {
      title: 'Read last Muse reply',
      description: 'Return the most recent assistant message from the current thread without sending anything.',
      inputSchema: {},
    },
    wrap(async () => driver.readLast()),
  )

  server.registerTool(
    'muse_chats',
    {
      title: 'List Muse chats',
      description: 'List the chats in the Muse sidebar (Main chat, Channels, Side chats) with an active flag. Optionally filter by title.',
      inputSchema: {
        query: z.string().optional().describe('Optional case-insensitive title filter.'),
      },
    },
    wrap(async ({ query }) => driver.listChats(query)),
  )

  server.registerTool(
    'muse_open_chat',
    {
      title: 'Open Muse chat',
      description: 'Open a specific Muse chat so later reads/sends target it (instead of the main chat).',
      inputSchema: {
        target: z.union([z.string(), z.number()]).describe('Chat title (substring), index from muse_chats, a thread URL, or a thread id.'),
      },
    },
    wrap(async ({ target }) => driver.openChat(target)),
  )

  server.registerTool(
    'muse_read_chat',
    {
      title: 'Read Muse chat',
      description: 'Return the messages of a chat (all roles) without sending anything. Optionally open a chat first.',
      inputSchema: {
        chat: z.union([z.string(), z.number()]).optional().describe('Optional chat to open first (title, index, URL, or id).'),
        max: z.number().int().positive().max(500).optional().describe('Max messages to return from the end (default 100).'),
      },
    },
    wrap(async ({ chat, max }) => {
      if (chat !== undefined && chat !== null && chat !== '') await driver.openChat(chat)
      return driver.readChat(max || 100)
    }),
  )

  server.registerTool(
    'muse_media',
    {
      title: 'Muse chat media',
      description: 'Extract image/video/attachment links from a chat (Muse replies with share links for generated media). Optionally download them.',
      inputSchema: {
        chat: z.union([z.string(), z.number()]).optional().describe('Chat to open first (title, index, URL, or id).'),
        download: z.boolean().optional().describe('Download the media to disk (default false).'),
        dir: z.string().optional().describe('Directory for downloads (default: ./downloads next to the server).'),
      },
    },
    wrap(async ({ chat, download, dir }) => driver.chatMedia(chat, { download: !!download, dir })),
  )

  server.registerTool(
    'muse_dump_dom',
    {
      title: 'Dump Muse DOM',
      description: 'Diagnostics: element counts and transcript HTML. Use if selectors stop matching after a Muse update.',
      inputSchema: {
        max_chars: z.number().int().positive().max(200000).optional().describe('Truncate HTML to this many characters (default 20000).'),
      },
    },
    wrap(async ({ max_chars }) => driver.dumpDom(max_chars || 20000)),
  )

  server.registerTool(
    'muse_close',
    {
      title: 'Close Muse browser',
      description: 'Close the dedicated Chrome window and release the profile.',
      inputSchema: {},
    },
    wrap(async () => driver.close()),
  )

  return server
}

async function main() {
  const shutdown = async () => {
    await driver.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.stdin.on('close', shutdown)

  const args = process.argv.slice(2)

  if (args.includes('--login')) {
    await driver.launch()
    const initialStatus = await driver.status()
    if (initialStatus.loggedIn) {
      log('Already logged in to muse.ai!')
      log('Status:', JSON.stringify(initialStatus))
      await driver.close()
      process.exit(0)
    }
    log('Opened Chrome. Please sign in with your Meta account at muse.ai in the opened window...')
    log('Waiting for login to complete (timeout: 5 minutes)...')
    const timeoutMs = Number(process.env.MUSE_LOGIN_TIMEOUT_MS) || 300000
    const res = await driver.login(timeoutMs)
    if (res.loggedIn) {
      log('Login successful! Viewer ID:', res.viewerId)
      const st = await driver.status()
      log('Status:', JSON.stringify(st))
    } else {
      log('Login was not completed:', res.hint || 'Timed out.')
    }
    await driver.close()
    process.exit(res.loggedIn ? 0 : 1)
  }

  if (args.includes('--self-test')) {
    await driver.launch()
    const st = await driver.status()
    log('self-test status:', JSON.stringify(st))
    if (!st.loggedIn) {
      const isAutomated = st.headless || !!process.env.CI || args.includes('--no-wait') || process.env.MUSE_SELFTEST_NOWAIT === '1'
      if (isAutomated) {
        log('Not logged in. (Non-interactive/headless mode: exiting without waiting for login)')
        await driver.close()
        process.exit(1)
      } else {
        log('Not logged in yet. Please sign in with your Meta account in the opened Chrome window...')
        log('Waiting for login to complete (timeout: 5 minutes)...')
        const timeoutMs = Number(process.env.MUSE_LOGIN_TIMEOUT_MS) || 300000
        const loginRes = await driver.login(timeoutMs)
        if (loginRes.loggedIn) {
          const finalSt = await driver.status()
          log('Login successful! Updated status:', JSON.stringify(finalSt))
        } else {
          log('Login was not completed:', loginRes.hint || 'Timed out.')
        }
        await driver.close()
        process.exit(loginRes.loggedIn ? 0 : 1)
      }
    }
    await driver.close()
    process.exit(0)
  }

  if (args.includes('--dump-dom')) {
    const d = await driver.dumpDom(4000)
    console.error(JSON.stringify({ url: d.url, counts: d.counts, hasApproval: d.hasApproval }, null, 2))
    await driver.close()
    process.exit(0)
  }

  // Optional OpenAI-compatible HTTP shim, sharing this same driver/browser.
  // Default port 8787; disable with MUSE_SHIM_PORT=0.
  const shimPort = process.env.MUSE_SHIM_PORT === undefined ? 8787 : Number(process.env.MUSE_SHIM_PORT)
  const startShimIfEnabled = () => { if (shimPort > 0) startShim({ port: shimPort }) }

  if (args.includes('--serve-only')) {
    startShimIfEnabled()
    return // keep the process alive on the HTTP listener only
  }

  const server = buildServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log('muse MCP server ready on stdio')
  startShimIfEnabled()
}

main().catch((err) => {
  log('fatal:', err)
  process.exit(1)
})
