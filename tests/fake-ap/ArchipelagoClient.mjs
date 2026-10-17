// Fake Archipelago client (tests only). The shims of make-shims.mjs run it as
// ArchipelagoBizHawkClient, ArchipelagoSNIClient, ArchipelagoTextClient, ArchipelagoLauncher and
// ArchipelagoLauncherDebug: it records how it was started (FAKE_RECORD) and exits 0.
import { exit, record } from './common.mjs'

record()
exit(0)
