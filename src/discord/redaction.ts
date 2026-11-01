const MARKER = "[redacted]";

// Long enough that an environment value is a secret and not a word that would then vanish from every message.
const MIN_OWN_SECRET_CHARS = 12;
const SECRET_NAME = /(?:TOKEN|SECRET|PASS(?:WORD|WD)?(?:_|$)|PWD$|_PAT$|KEY$|API_?KEY|CREDENTIALS?)/i;
// A name like API_KEY_HEADER can hold a word, a path or an address, which is no secret and appears everywhere.
const LOOKS_LIKE_SECRET = /^(?=\S*\d)(?=\S*[A-Za-z])(?!\/)(?![a-z][a-z0-9+.-]*:\/\/)\S+$/i;

// A key can follow a line break written into a JSON string, whose last letter is no reason to doubt it.
const STARTS = "(?:(?<![A-Za-z0-9])|(?<=\\\\[nrt]))";
// A key block arrives indented, quoted in a reply, flattened to spaces or written into JSON, and its lines are as long as its tool made them.
const KEY_LINE_BREAK = "(?:\\s|\\\\[rn]|>){1,8}";
const KEY_FOOTER = "-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----";

// What leads up to a secret and stays readable goes in a group named lead. A file of up to the attachment limit passes through these, so each is anchored and bounded: an open-ended run can stall the bridge or overflow the matcher.
const SHAPES: readonly RegExp[] = [
  // Lines of a full length are the body, so a header only mentioned in prose or a parser's source takes nothing with it.
  new RegExp(
    `-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:${KEY_LINE_BREAK}(?!-----)[A-Za-z0-9+/=]{16,8192}){1,4096}(?:${KEY_LINE_BREAK}(?!-----)[A-Za-z0-9+/=]{1,15}(?=${KEY_LINE_BREAK}${KEY_FOOTER}))?(?:${KEY_LINE_BREAK}${KEY_FOOTER})?`,
    "g",
  ),
  new RegExp(`${STARTS}sk-ant-[A-Za-z0-9_-]{20,4096}`, "g"),
  new RegExp(`${STARTS}sk-(?:proj-|svcacct-)?(?=[A-Za-z_-]{0,64}\\d)[A-Za-z0-9_-]{32,4096}`, "g"),
  /gh[pousr]_[A-Za-z0-9]{20,4096}/g,
  /github_pat_[A-Za-z0-9_]{20,4096}/g,
  /glpat-[A-Za-z0-9_-]{20,4096}/g,
  /(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g,
  new RegExp(`${STARTS}AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])`, "g"),
  /xox[abeoprs]-[0-9A-Za-z-]{10,4096}/g,
  /xapp-[0-9A-Za-z-]{10,4096}/g,
  new RegExp(`${STARTS}[sr]k_(?:live|test)_(?=[A-Za-z]{0,64}\\d)[0-9A-Za-z]{16,4096}`, "g"),
  /npm_[A-Za-z0-9]{30,4096}/g,
  /hf_[A-Za-z0-9]{30,4096}/g,
  /tskey-[A-Za-z0-9-]{20,4096}/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,8192}\.eyJ[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,8192}/g,
  // A Discord bot token: an id, a time and a signature.
  /(?<![A-Za-z0-9_-])[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,128}/g,
  /(?<lead>discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/)[A-Za-z0-9_-]{20,256}/g,
  /(?<lead>hooks\.slack\.com\/services\/)[A-Za-z0-9/]{20,256}/g,
  /(?<lead>(?<![A-Za-z])Bearer\s{1,4})[A-Za-z0-9._~+/-]{16,4096}={0,2}/gi,
  /(?<lead>(?<![A-Za-z])Basic\s{1,4})(?=.[a-z+/]{0,64}[A-Z0-9])[A-Za-z0-9+/]{16,4096}={0,2}/g,
  /(?<lead>(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]{1,256}:)[^\s/@]{3,256}(?=@)/gi,
  // Letters and two digits at least, or every long setting would go; what a dot follows is a file, what a bracket follows is a call.
  /(?<lead>(?:api[_-]?key|secret(?:[_-]?key)?|token|password|passwd|pwd)["'`*]{0,3}\s{0,4}[:=]\s{0,4}["'`]?)(?!\/)(?=[^\s"'`]{0,256}\d[^\s"'`]{0,256}\d)(?=[^\s"'`]{0,256}[A-Za-z])[A-Za-z0-9+/=_!@#$%^&*-]{16,512}(?![\w./()])/gi,
];

function hide(...found: unknown[]): string {
  const groups = found.at(-1);
  const lead = typeof groups === "object" ? (groups as { lead?: string }).lead : undefined;
  return `${lead ?? ""}${MARKER}`;
}

// A secret of any format is recognised by its value when the bridge itself was started with it.
export function ownSecrets(env: NodeJS.ProcessEnv): string[] {
  const values = Object.entries(env).flatMap(([name, value]) =>
    SECRET_NAME.test(name) && value && value.length >= MIN_OWN_SECRET_CHARS && LOOKS_LIKE_SECRET.test(value) ? [value] : [],
  );
  // Longest first, so a value holding another is taken whole.
  return [...new Set(values)].sort((one, other) => other.length - one.length);
}

export function redactSecretsFrom(text: string, own: readonly string[]): string {
  const known = own.reduce((result, value) => result.split(value).join(MARKER), text);
  return SHAPES.reduce((result, shape) => result.replace(shape, hide), known);
}

export function holdsSecretFrom(text: string, own: readonly string[]): boolean {
  return own.some((value) => text.includes(value)) || SHAPES.some((shape) => text.search(shape) >= 0);
}

const RUNNING_SECRETS = ownSecrets(process.env);

export function redactSecrets(text: string): string {
  return redactSecretsFrom(text, RUNNING_SECRETS);
}

// Dropping the zero bytes reads UTF-16 as plain text, and a key stored in an archive or a document as well; a file is withheld rather than altered, since an edited copy would pass for the real thing.
export function fileHoldsSecret(data: Buffer): boolean {
  return holdsSecretFrom(data.toString("latin1").replaceAll("\0", ""), RUNNING_SECRETS);
}
