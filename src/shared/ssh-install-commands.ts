import { DEVICE_PATHS } from './types'

/** Text file uploaded beside the .pub — open on BB10, copy, paste into Term49. */
export const TERM49_SSH_KEY_SCRIPT = 'term49-ssh-key-install.txt'

/** Match ssh-keygen naming in SshManager.generateKey (adds id_ prefix). */
export function sshKeyBaseName(nameOrPath: string): string {
  let base = nameOrPath.split('/').pop() || nameOrPath || 'rsa_bb10'
  if (base.endsWith('.pub')) base = base.slice(0, -4)
  return base.startsWith('id_') ? base : `id_${base}`
}

export function pubKeyFileName(keyPathOrName: string): string {
  return `${sshKeyBaseName(keyPathOrName)}.pub`
}

/** Shell commands to run in Term49 after uploading *.pub via WiFi Storage. */
export function term49AuthorizedKeysCommands(pubFileName: string): string {
  const setupDir = DEVICE_PATHS.berrycore.transferDir
  const berrycore = DEVICE_PATHS.berrycore.defaultInstall
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
  return [
    // A subshell stops on failure without exiting the user's Term49 session.
    '(',
    'set -e',
    'umask 077',
    `test -r ${quote(`${berrycore}/env.sh`)} || { echo "BerryCore env.sh is not readable." >&2; exit 1; }`,
    `. ${quote(`${berrycore}/env.sh`)}`,
    'test -n "$HOME" && test -d "$HOME" || { echo "Term49 HOME is missing or unavailable." >&2; exit 1; }',
    'berrybridge_ssh_dir="$HOME/.ssh"',
    `test -r ${quote(`${setupDir}/${pubFileName}`)} || { echo "Uploaded public key is not readable in Documents." >&2; exit 1; }`,
    'mkdir -p "$berrybridge_ssh_dir" || { echo "Cannot create $berrybridge_ssh_dir. Check Term49 directory permissions." >&2; exit 1; }',
    'chmod 700 "$berrybridge_ssh_dir"',
    'test -f "$berrybridge_ssh_dir/id_rsa" || ssh-keygen -t rsa -b 2048 -f "$berrybridge_ssh_dir/id_rsa" -N ""',
    `cat ${quote(`${setupDir}/${pubFileName}`)} >> "$berrybridge_ssh_dir/authorized_keys"`,
    'chmod 600 "$berrybridge_ssh_dir/authorized_keys"',
    'sshd',
    ')'
  ].join('\n')
}

/** Contents of {@link TERM49_SSH_KEY_SCRIPT} — plain commands, one block to copy. */
export function term49SshKeyInstallScriptContent(pubFileName: string): string {
  return term49AuthorizedKeysCommands(pubFileName)
}

/** Short instructions for alerts / backend messages after WiFi Storage upload. */
export function term49ManualInstallMessage(pubFileName: string): string {
  const dir = DEVICE_PATHS.berrycore.transferDir
  return `Uploaded ${pubFileName} and ${TERM49_SSH_KEY_SCRIPT} to ${dir}/ via WiFi Storage.

Finish on the phone: open ${TERM49_SSH_KEY_SCRIPT} in ${dir}, copy all, paste into Term49 (meta mode + Ctrl+V), and run. The script uses Term49's $HOME/.ssh, runs ssh-keygen if needed, adds your Mac key to authorized_keys, and starts sshd. If a step fails, it stops without closing Term49. Then test SSH again in Berry Bridge.`
}

