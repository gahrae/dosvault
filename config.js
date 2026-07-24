// Configuration with platform-aware defaults, overridable via ./config.json
// (gitignored, see config.example.json) and the PORT environment variable.
// Command values are argv arrays; {archive} {dest} {dir} placeholders are
// substituted at call time.
const os = require('os');
const path = require('path');
const fs = require('fs');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const DEFAULTS = {
  port: 3456,
  // where games are installed, one subfolder per game
  gamesDir: path.join(os.homedir(), 'dosgames'),
  // base command to launch DOSBox; mount/exe args are appended
  dosbox: ['dosbox'],
  // extract {archive} into {dest}  (Windows 10+ ships bsdtar, which reads zips)
  unzip: isWin ? ['tar', '-xf', '{archive}', '-C', '{dest}'] : ['unzip', '-o', '{archive}', '-d', '{dest}'],
  // list entry paths inside {archive}, one per line
  unzipList: isWin ? ['tar', '-tf', '{archive}'] : ['unzip', '-Z1', '{archive}'],
  // list file paths inside a CD image {archive}, one per line
  // (Windows/macOS tar is bsdtar, which reads ISO9660; isoinfo is from cdrtools/genisoimage)
  isoList: isWin || isMac ? ['tar', '-tf', '{archive}'] : ['isoinfo', '-f', '-i', '{archive}'],
  // open {dir} in the system file manager
  openFolder: isWin ? ['explorer', '{dir}'] : isMac ? ['open', '{dir}'] : ['xdg-open', '{dir}'],
};

let overrides = {};
const cfgPath = path.join(__dirname, 'config.json');
if (fs.existsSync(cfgPath)) overrides = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const config = { ...DEFAULTS, ...overrides };
if (process.env.PORT) config.port = +process.env.PORT;
config.gamesDir = config.gamesDir.replace(/^~(?=$|[\\/])/, os.homedir());

// fill(['unzip', '-o', '{archive}'], { archive: '/x.zip' }) -> ['unzip', '-o', '/x.zip']
const fill = (argv, vars) => argv.map((a) => a.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m));

module.exports = { config, fill };
