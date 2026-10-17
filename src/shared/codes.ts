// Every code the main process can return. The renderer translates each one (FR and EN); the main
// process never produces user-facing text.

export const ERROR_CODES = [
  // Generic
  'NOT_IMPLEMENTED',
  'INVALID_INPUT',
  'NOT_FOUND',
  'PATH_FORBIDDEN',
  'TASK_CANCELLED',
  'UNSUPPORTED_PLATFORM',
  // Archipelago and its settings
  'AP_NOT_INSTALLED',
  'AP_RUNNING',
  'SETTINGS_LOCKED',
  // Network
  'NETWORK_OFFLINE',
  'GITHUB_RATE_LIMITED',
  'HTTP_ERROR',
  // Downloads and installation
  'DOWNLOAD_HASH_MISMATCH',
  'INSTALL_ELEVATION_DENIED',
  'INSTALL_FAILED',
  // Worlds
  'WORLD_INVALID',
  'WORLD_INCOMPATIBLE',
  'WORLD_CORRUPT_BLOCKING',
  'WORLD_RELEASE_UNAVAILABLE',
  // YAML
  'YAML_PARSE',
  // Generation
  'GENERATION_PREFLIGHT',
  'GENERATION_FAILED',
  'PROCESS_TIMEOUT',
  // Local server
  'PORT_IN_USE',
  'SERVER_START_FAILED',
  // archipelago.gg
  'WEBHOST_UPLOAD_FAILED',
  'WEBHOST_ROOM_FAILED',
  'WEBHOST_UNAVAILABLE',
  // Joining and ROMs
  'JOIN_BAD_INPUT',
  'PATCH_INVALID',
  'ROM_MISSING',
  'ROM_BAD_HASH',
  // BizHawk and secrets
  'BIZHAWK_PREREQ_MISSING',
  'SECRETS_UNAVAILABLE',
  // Archipelago errors translated from its output
  'AP_YAML_INVALID',
  'AP_WORLD_NOT_FOUND',
  'AP_NO_GAME_OPTIONS',
  'AP_QUANTITY_DISABLED',
  'AP_VERSION_REQUIRED',
  'AP_PLANDO_DISABLED',
  'AP_NAMES_NOT_UNIQUE',
  'AP_FILL_UNBEATABLE',
  'AP_FILL_NO_SPOTS',
  'AP_FILL_NOT_ENOUGH_LOCATIONS',
  'AP_FILL_FAILED',
  'AP_ROM_MISSING',
  'AP_ROM_HASH',
  'AP_MULTIDATA_INCOMPATIBLE',
  'AP_SERVER_TOO_OLD',
  'AP_NO_ARCHIPELAGO_IN_ZIP',
  'AP_PORT_IN_USE',
  'AP_UNKNOWN',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export const ISSUE_CODES = [
  // YAML and encoding
  'yaml-syntax',
  'duplicate-key',
  'encoding-fallback',
  // Game
  'no-game',
  'game-not-installed',
  'game-unconfirmed',
  'game-section-missing',
  'game-section-null',
  // Name
  'name-too-long',
  'name-reserved',
  'name-numeric',
  'name-duplicate',
  // `requires`
  'requires-version-format',
  'requires-version-too-new',
  'requires-plando-disabled',
  'requires-game-version',
  // Options
  'option-unknown',
  'option-invalid-value',
  'option-float',
  'weights-all-zero',
  'quantity-disabled',
  'root-common-option',
  'plando-items-disabled',
  // Files and worlds
  'not-yaml-file',
  'world-no-manifest',
  'world-version-conflict',
  'patch-server-stale',
] as const
export type IssueCode = (typeof ISSUE_CODES)[number]

export const DOCTOR_CHECK_IDS = [
  'ap-installed',
  'ap-update',
  'settings-file',
  'worlds-corrupt',
  'worlds-no-manifest',
  'worlds-incompatible',
  'worlds-shadowed',
  'worlds-bad-name',
  'ap-processes',
  'port-38281',
  'bizhawk',
  'disk-space',
  'programdata-acl',
  'glibc',
  'chromium-sandbox',
  'network',
] as const
export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number]

export const GENERATE_STAGE_IDS = [
  'init',
  'weights',
  'generating',
  'worlds',
  'creating',
  'items',
  'rules',
  'plando',
  'prefill',
  'fill',
  'balancing',
  'preoutput',
  'output',
  'output-files',
  'playthrough',
  'archive',
  'done',
] as const
export type GenerateStageId = (typeof GENERATE_STAGE_IDS)[number]

/** Values of `CheckItem.code` (join checklist), translated like the other codes. */
export const CHECK_CODES = [
  'ap-ok',
  'ap-missing',
  'world-ok',
  'world-missing',
  'world-unconfirmed',
  'rom-ok',
  'rom-missing',
  'rom-bad-hash',
  'rom-apply-from-vault',
  'emulator-ok',
  'emulator-missing',
  'emulator-not-configured',
  'emulator-assisted',
  'na',
] as const
export type CheckCode = (typeof CHECK_CODES)[number]
