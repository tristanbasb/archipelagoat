// The server console: its log, a command line with history (up and down arrows) and quick
// commands. /release and /collect name a player, picked in a dialog.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from '../../design/classes'
import { Modal, NeonButton, Select, Terminal, Tooltip, type TerminalLine } from '../../design/components'
import { appendCapped } from './live-state'
import './ConsolePanel.css'

const KEY = 'screens.host.console'

/** Commands sent as they are (MultiServer.py, ServerCommandProcessor). */
const DIRECT = [
  { command: '/players', hint: 'players' },
  { command: '/status', hint: 'status' },
  { command: '/countdown 10', hint: 'countdown' },
  { command: '/save', hint: 'save' },
] as const

/** Commands that take a player name; they read it raw (`mark_raw`), so it is never quoted. */
type PlayerCommand = 'release' | 'collect'
const PLAYER_COMMANDS: readonly PlayerCommand[] = ['release', 'collect']

/** Commands kept for the up arrow. */
const HISTORY_SIZE = 100

export interface ConsolePanelProps {
  title: string
  lines: readonly TerminalLine[]
  /** Absent while the console cannot take commands. */
  onCommand?: (command: string) => void
  /** Slot names, for /release and /collect. */
  players: readonly string[]
  className?: string
}

export function ConsolePanel({
  title,
  lines,
  onCommand,
  players,
  className,
}: ConsolePanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const [history, setHistory] = useState<string[]>([])
  // The dialog keeps its command while it closes, so its text does not change on the way out.
  const [asking, setAsking] = useState<{ command: PlayerCommand; open: boolean }>({
    command: 'release',
    open: false,
  })
  const [player, setPlayer] = useState<string | null>(null)

  const send = (command: string): void => {
    if (!onCommand) return
    setHistory((list) => appendCapped(list, [command], HISTORY_SIZE))
    onCommand(command)
  }

  const ask = (command: PlayerCommand): void => {
    setPlayer(null)
    setAsking({ command, open: true })
  }
  const closeDialog = (): void => setAsking((current) => ({ ...current, open: false }))

  const shownLines = onCommand ? lines : [...lines, { text: t(`${KEY}.offline`), tone: 'dim' as const }]

  return (
    <div className={cx('console-panel', className)}>
      <Terminal
        label={title}
        lines={shownLines}
        onCommand={onCommand ? send : undefined}
        history={history}
        inputLabel={t(`${KEY}.input`)}
        placeholder={t(`${KEY}.placeholder`)}
      />
      <div role="group" aria-label={t(`${KEY}.shortcuts`)} className="console-panel__shortcuts">
        {DIRECT.map(({ command, hint }) => (
          <Tooltip key={command} content={t(`${KEY}.commands.${hint}`)} side="bottom">
            <NeonButton
              variant="ghost"
              size="sm"
              className="console-panel__command"
              disabled={!onCommand}
              onClick={() => send(command)}
            >
              {command}
            </NeonButton>
          </Tooltip>
        ))}
        {PLAYER_COMMANDS.map((command) => (
          <Tooltip key={command} content={t(`${KEY}.commands.${command}`)} side="bottom">
            <NeonButton
              variant="ghost"
              size="sm"
              className="console-panel__command"
              disabled={!onCommand || players.length === 0}
              onClick={() => ask(command)}
            >
              {`/${command}…`}
            </NeonButton>
          </Tooltip>
        ))}
      </div>
      <Modal
        open={asking.open}
        onClose={closeDialog}
        tone="yellow"
        size="sm"
        title={t(`${KEY}.${asking.command}.title`)}
        closeLabel={t('common.closeDialog')}
        footer={
          <>
            <NeonButton variant="ghost" onClick={closeDialog}>
              {t('common.cancel')}
            </NeonButton>
            <NeonButton
              variant="primary"
              disabled={player === null}
              onClick={() => {
                if (player !== null) send(`/${asking.command} ${player}`)
                closeDialog()
              }}
            >
              {t(`${KEY}.${asking.command}.confirm`)}
            </NeonButton>
          </>
        }
      >
        <div className="console-panel__ask">
          <p>{t(`${KEY}.${asking.command}.body`)}</p>
          <Select
            label={t(`${KEY}.player`)}
            placeholder={t(`${KEY}.pickPlayer`)}
            value={player}
            options={players.map((name) => ({ value: name, label: name }))}
            onChange={setPlayer}
          />
        </div>
      </Modal>
    </div>
  )
}
