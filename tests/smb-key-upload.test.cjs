const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')

// Exercise the TypeScript service without starting Electron or contacting a phone.
const root = path.resolve(__dirname, '..')
const modules = new Map()
function load(file) {
  if (modules.has(file)) return modules.get(file).exports
  const module = { exports: {} }
  modules.set(file, module)
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const localRequire = (name) => {
    if (name === 'electron') return { app: {} }
    if (name.startsWith('@shared/')) return load(path.join(root, 'src/shared', name.slice(8) + '.ts'))
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'))
    return require(name)
  }
  const wrapper = vm.runInThisContext(`(function(require,module,exports,__dirname){${compiled}\n})`, { filename: file })
  wrapper(localRequire, module, module.exports, path.dirname(file))
  return module.exports
}
const { Bb10SmbClient } = load(path.join(root, 'src/main/services/bb10-smb-client.ts'))

async function withClient(fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'berrybridge-key-test-'))
  const key = path.join(temp, 'id_rsa_bb10.pub')
  fs.writeFileSync(key, 'ssh-rsa TEST public-key-only\n')
  const client = Object.create(Bb10SmbClient.prototype)
  try { await fn(client, key) } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}

for (const [share, directory] of [
  ['media', 'accounts/1000/shared/documents'],
  ['media', 'documents'],
  ['media', 'shared/documents'],
  ['documents', '']
]) {
  test(`key and instructions use ${share}/${directory || '(root)'}`, () => withClient(async (client, key) => {
    const uploads = []
    client.listDirectory = async (host, actualShare, password, dir, username) => {
      assert.deepEqual([host, actualShare, password, username], ['phone', share, 'test-password', 'blackberry'])
      if (dir !== directory) throw new Error('NT_STATUS_OBJECT_PATH_NOT_FOUND')
      return [] // An empty Documents directory is valid.
    }
    client.uploadFile = async (host, actualShare, password, local, remote, username) => {
      uploads.push({ local, remote, contents: fs.readFileSync(local, 'utf8') })
      assert.equal(actualShare, share)
      assert.equal(username, 'blackberry')
    }
    const result = await client.provisionSshKey('phone', share, 'test-password', key, 'blackberry')
    const prefix = directory ? directory + '/' : ''
    assert.deepEqual(uploads.map(u => u.remote), [prefix + 'id_rsa_bb10.pub', prefix + 'term49-ssh-key-install.txt'])
    assert.ok(uploads[1].contents.includes("cat '/accounts/1000/shared/documents/id_rsa_bb10.pub'"))
    assert.equal(result.keyFileName, 'id_rsa_bb10.pub')
    assert.equal(fs.existsSync(uploads[1].local), false)
  }))
}

test('missing Documents fails before uploading, even when media root is readable', () => withClient(async (client, key) => {
  client.listDirectory = async (_host, _share, _password, dir) => {
    if (dir === '') return []
    throw new Error('NT_STATUS_OBJECT_PATH_NOT_FOUND')
  }
  client.uploadFile = async () => assert.fail('must not upload into an unknown directory')
  await assert.rejects(client.provisionSshKey('phone', 'media', 'test-password', key), /Could not find the Documents directory/)
}))

test('failed script upload removes the temporary script', () => withClient(async (client, key) => {
  let script
  client.listDirectory = async () => []
  client.uploadFile = async (_host, _share, _password, local) => {
    if (local !== key) { script = local; throw new Error('upload failed') }
  }
  await assert.rejects(client.provisionSshKey('phone', 'media', 'test-password', key), /upload failed/)
  assert.ok(script)
  assert.equal(fs.existsSync(script), false)
}))

const { spawnSync } = require('node:child_process')
const { DEVICE_PATHS } = load(path.join(root, 'src/shared/types.ts'))
const { term49AuthorizedKeysCommands } = load(path.join(root, 'src/shared/ssh-install-commands.ts'))

for (const scenario of ['success', 'permission denied', 'missing HOME', 'missing public key']) {
  test(`Term49 script: ${scenario}`, { skip: process.platform === 'win32' }, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'berrybridge-shell-test-'))
    const userHome = path.join(temp, 'Term49 home')
    const bin = path.join(temp, 'bin')
    const docs = path.join(temp, 'documents')
    const install = path.join(temp, 'berrycore')
    const originalInstall = DEVICE_PATHS.berrycore.defaultInstall
    const originalDocs = DEVICE_PATHS.berrycore.transferDir
    try {
      for (const dir of [userHome, bin, docs, install]) fs.mkdirSync(dir)
      fs.writeFileSync(path.join(install, 'env.sh'), ':\n')
      const pubName = "id_rsa user's.pub"
      if (scenario !== 'missing public key') fs.writeFileSync(path.join(docs, pubName), 'ssh-rsa TEST\n')
      fs.writeFileSync(path.join(bin, 'ssh-keygen'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = "-f" ]; then shift; touch "$1"; exit; fi\n shift\ndone\nexit 1\n', { mode: 0o755 })
      fs.writeFileSync(path.join(bin, 'sshd'), '#!/bin/sh\ntouch "$HOME/sshd-started"\n', { mode: 0o755 })
      if (scenario === 'permission denied') {
        fs.writeFileSync(path.join(bin, 'mkdir'), '#!/bin/sh\necho "Permission denied" >&2\nexit 1\n', { mode: 0o755 })
      }
      DEVICE_PATHS.berrycore.defaultInstall = install
      DEVICE_PATHS.berrycore.transferDir = docs
      const script = term49AuthorizedKeysCommands(pubName)
      const env = { ...process.env, HOME: scenario === 'missing HOME' ? '' : userHome, PATH: bin + ':' + process.env.PATH }
      const result = spawnSync('/bin/sh', ['-c', script], { env, encoding: 'utf8' })
      if (scenario === 'success') {
        assert.equal(result.status, 0, result.stderr)
        assert.equal(fs.readFileSync(path.join(userHome, '.ssh/authorized_keys'), 'utf8'), 'ssh-rsa TEST\n')
        assert.equal(fs.statSync(path.join(userHome, '.ssh')).mode & 0o777, 0o700)
        assert.equal(fs.statSync(path.join(userHome, '.ssh/authorized_keys')).mode & 0o777, 0o600)
        assert.ok(fs.existsSync(path.join(userHome, 'sshd-started')))
      } else {
        assert.notEqual(result.status, 0)
        assert.equal(fs.existsSync(path.join(userHome, 'sshd-started')), false)
        assert.equal(fs.existsSync(path.join(userHome, '.ssh/authorized_keys')), false)
        const interactive = spawnSync('/bin/sh', ['-c', script + '\nprintf "session alive"'], { env, encoding: 'utf8' })
        assert.match(interactive.stdout, /session alive/)
      }
    } finally {
      DEVICE_PATHS.berrycore.defaultInstall = originalInstall
      DEVICE_PATHS.berrycore.transferDir = originalDocs
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })
}
