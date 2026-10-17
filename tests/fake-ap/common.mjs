// What the fake Archipelago programs share (tests only): the FAKE_MODE flags, an output that a
// `buffered` run holds back like the block-buffered stdout of a piped Python, the FAKE_RECORD file
// and the captured Archipelago output. Paths are taken from this file, so the fakes keep working
// when they run through a shim copied elsewhere (make-shims.mjs).
import { readFileSync, writeFileSync, writeSync } from 'node:fs'
import { basename } from 'node:path'

/** FAKE_MODE holds one flag or more: `fail`, `slow,buffered`… */
export const modes = new Set((process.env.FAKE_MODE ?? '').split(/[\s,]+/).filter(Boolean))

/** The program this run stands for: the name of the script (or shim) Node was given. */
export const program = basename(process.argv[1] ?? 'ArchipelagoClient').replace(/\.[cm]?js$/, '')

/** The arguments after the script. */
export const argv = process.argv.slice(2)

/** The value after `name` (`--port 38281` or `--port=38281`). */
export function argValue(name) {
  for (const [i, arg] of argv.entries()) {
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

const held = []

function write(fd, text) {
  try {
    // Synchronous, so that process.exit never drops a line.
    writeSync(fd, text)
  } catch {
    // The reader is gone.
  }
}

function emit(fd, text) {
  if (modes.has('buffered')) held.push([fd, text])
  else write(fd, text)
}

export const out = (line) => emit(1, `${line}\n`)
export const err = (line) => emit(2, `${line}\n`)
/** Text without a line end, like the prompt of Python's `input()`. */
export const prompt = (text) => emit(1, text)

/** Writes what a `buffered` run held back. */
export function flush() {
  for (const [fd, text] of held.splice(0)) write(fd, text)
}

// A normal exit empties the buffer (Python flushes stdout at exit); a kill loses it.
process.on('exit', flush)

export function exit(code) {
  flush()
  process.exit(code)
}

/** The lines of a captured output of tests/fixtures/ap-output. */
export function fixtureLines(name) {
  const text = readFileSync(new URL(`../fixtures/ap-output/${name}`, import.meta.url), 'utf8')
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

const RECORDED_ENV = /^(?:PYTHON\w*|LD_LIBRARY_PATH|ELECTRON_RUN_AS_NODE|FAKE_\w+|GOAT_\w+)$/

/** Writes how this run was started to the FAKE_RECORD file, when there is one. */
export function record() {
  const file = process.env.FAKE_RECORD
  if (!file) return
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => RECORDED_ENV.test(key)))
  const runtime = process.versions.electron ? 'electron' : 'node'
  writeFileSync(file, JSON.stringify({ program, argv, cwd: process.cwd(), env, runtime }, null, 2))
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
