// The games whose base ROM Archipelago recognises (vault:table), split between the ROMs the host needs
// to generate and the ones only the player needs to patch, with what the vault already holds. Names
// and expected versions only: the app never offers a ROM or a link to one.
import { IconRefresh } from '@tabler/icons-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { RomRecord, RomTableEntry } from '@shared/types'
import { Badge, ErrorPanel, NeonButton, PixelPanel, Spinner, StatusPill } from '../../design/components'
import { cx, toneClass, type Tone } from '../../design/classes'
import { useIpcQuery } from '../../hooks/useIpc'
import { errorPanelProps } from './error-props'
import './SupportedGames.css'

/** Settings keys the vault holds a recognised ROM for. */
export function foundKeys(records: readonly RomRecord[]): Set<string> {
  const keys = new Set<string>()
  for (const record of records) if (record.game !== null && record.settingsKey) keys.add(record.settingsKey)
  return keys
}

const byGame = (a: RomTableEntry, b: RomTableEntry): number =>
  a.game.localeCompare(b.game) || a.label.localeCompare(b.label)

export interface SupportedGamesProps {
  records: readonly RomRecord[]
}

export function SupportedGames({ records }: SupportedGamesProps): React.JSX.Element {
  const { t } = useTranslation()
  // The table belongs to the Archipelago version: it does not change while the app runs.
  const table = useIpcQuery('vault:table', undefined, { staleTime: Infinity })
  const found = foundKeys(records)
  const entries = table.data ?? []
  const inVault = entries.filter((entry) => found.has(entry.settingsKey)).length

  return (
    <PixelPanel
      tone="violet"
      eyebrow={t('screens.vault.games.eyebrow')}
      title={t('screens.vault.games.title')}
      actions={
        table.data && (
          <Badge tone={inVault > 0 ? 'green' : 'neutral'}>
            {t('screens.vault.games.count', { found: inVault, total: entries.length })}
          </Badge>
        )
      }
      className="supported-games"
    >
      <p className="supported-games__lead">{t('screens.vault.games.lead')}</p>

      {table.isPending && <Spinner label={t('screens.vault.games.loading')} />}

      {table.isError && (
        <ErrorPanel
          {...errorPanelProps(table.error, t)}
          actions={
            <NeonButton
              size="sm"
              variant="secondary"
              icon={<IconRefresh />}
              onClick={() => void table.refetch()}
            >
              {t('common.retry')}
            </NeonButton>
          }
        />
      )}

      {table.data && (
        <div className="supported-games__groups">
          <GameGroup
            tone="yellow"
            title={t('screens.vault.games.generation')}
            hint={t('screens.vault.games.generationHint')}
            entries={entries.filter((entry) => entry.requiredAtGeneration).sort(byGame)}
            found={found}
          />
          <GameGroup
            tone="cyan"
            title={t('screens.vault.games.play')}
            hint={t('screens.vault.games.playHint')}
            entries={entries.filter((entry) => !entry.requiredAtGeneration).sort(byGame)}
            found={found}
          />
        </div>
      )}
    </PixelPanel>
  )
}

interface GameGroupProps {
  tone: Tone
  title: string
  hint: string
  entries: RomTableEntry[]
  found: Set<string>
}

function GameGroup({ tone, title, hint, entries, found }: GameGroupProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const titleId = useId()
  if (entries.length === 0) return null
  return (
    <section className={cx('games-group', toneClass(tone))} aria-labelledby={titleId}>
      <header className="games-group__head">
        <h3 id={titleId} className="games-group__title">
          {title}
        </h3>
        <p className="games-group__hint">{hint}</p>
      </header>
      <div className="games-group__scroll">
        <table className="games-table" aria-labelledby={titleId}>
          <thead>
            <tr>
              <th scope="col">{t('screens.vault.games.columns.game')}</th>
              <th scope="col">{t('screens.vault.games.columns.rom')}</th>
              <th scope="col">{t('screens.vault.games.columns.key')}</th>
              <th scope="col">{t('screens.vault.games.columns.status')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const inVault = found.has(entry.settingsKey)
              return (
                <tr key={entry.settingsKey} data-found={inVault || undefined}>
                  <th scope="row" className="games-table__game">
                    {entry.game}
                  </th>
                  <td className="games-table__label">{entry.label}</td>
                  <td className="games-table__key">
                    <code>{entry.settingsKey}</code>
                  </td>
                  <td className="games-table__status">
                    <StatusPill
                      status={inVault ? 'ok' : 'idle'}
                      label={t(inVault ? 'screens.vault.games.found' : 'screens.vault.games.absent')}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
