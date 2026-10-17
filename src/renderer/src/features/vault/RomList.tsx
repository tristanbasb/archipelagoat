// The ROMs of the vault: the recognised ones (game, expected version, MD5 ✓, path) and the ones
// whose fingerprint matches nothing Archipelago expects. The vault only holds references: removing
// one never touches the file.
import { IconCircleCheck, IconFileUnknown, IconFolder, IconTrash } from '@tabler/icons-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { RomRecord } from '@shared/types'
import { Badge, Tooltip } from '../../design/components'
import { cx, toneClass, type Tone } from '../../design/classes'
import './RomList.css'

export interface RomListProps {
  records: RomRecord[]
  onRemove: (record: RomRecord) => void
  /** Path of the record being removed, if any. */
  removing?: string | null
}

/** Cartridge colours, by file extension (a hint of the console; the MD5 decides the game). */
const EXTENSION_TONE: Record<string, Tone> = {
  sfc: 'violet',
  smc: 'violet',
  gb: 'green',
  gbc: 'green',
  gba: 'cyan',
  nes: 'pink',
  z64: 'yellow',
  n64: 'yellow',
  v64: 'yellow',
}

const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const

export function splitPath(path: string): { dir: string; name: string } {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (index < 0) return { dir: '', name: path }
  return { dir: path.slice(0, index) || path.slice(0, 1), name: path.slice(index + 1) }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function formatSize(bytes: number, locale: string): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: UNITS[unit],
    unitDisplay: 'short',
    maximumFractionDigits: unit > 0 && value < 10 ? 1 : 0,
  }).format(value)
}

function shortMd5(md5: string): string {
  return md5.length > 16 ? `${md5.slice(0, 8)}…${md5.slice(-4)}` : md5
}

export function RomList({ records, onRemove, removing = null }: RomListProps): React.JSX.Element {
  const { t } = useTranslation()
  const recognised = records
    .filter((record) => record.game !== null)
    .sort(
      (a, b) => (a.game ?? '').localeCompare(b.game ?? '') || (a.label ?? '').localeCompare(b.label ?? ''),
    )
  const unknown = records
    .filter((record) => record.game === null)
    .sort((a, b) => splitPath(a.path).name.localeCompare(splitPath(b.path).name))

  return (
    <div className="rom-list">
      {recognised.length > 0 && (
        <RomGroup
          tone="green"
          icon={<IconCircleCheck />}
          title={t('screens.vault.list.recognisedTitle')}
          label={t('screens.vault.list.recognised')}
          records={recognised}
          onRemove={onRemove}
          removing={removing}
        />
      )}
      {unknown.length > 0 && (
        <RomGroup
          tone="neutral"
          icon={<IconFileUnknown />}
          title={t('screens.vault.list.unknownTitle')}
          label={t('screens.vault.list.unknown')}
          hint={t('screens.vault.list.unknownHint')}
          records={unknown}
          onRemove={onRemove}
          removing={removing}
        />
      )}
    </div>
  )
}

interface RomGroupProps {
  tone: Tone
  icon: React.ReactNode
  title: string
  /** Names the list. */
  label: string
  hint?: string
  records: RomRecord[]
  onRemove: (record: RomRecord) => void
  removing: string | null
}

function RomGroup({
  tone,
  icon,
  title,
  label,
  hint,
  records,
  onRemove,
  removing,
}: RomGroupProps): React.JSX.Element {
  const titleId = useId()
  return (
    <section className={cx('rom-group', toneClass(tone))} aria-labelledby={titleId}>
      <h3 id={titleId} className="rom-group__title">
        <span className="rom-group__icon" aria-hidden="true">
          {icon}
        </span>
        {title} <span className="rom-group__count">{records.length}</span>
      </h3>
      {hint !== undefined && <p className="rom-group__hint">{hint}</p>}
      <ul className="rom-group__list" aria-label={label}>
        {records.map((record) => (
          <RomRow
            key={record.path}
            record={record}
            onRemove={() => onRemove(record)}
            removing={removing === record.path}
          />
        ))}
      </ul>
    </section>
  )
}

interface RomRowProps {
  record: RomRecord
  onRemove: () => void
  removing: boolean
}

function RomRow({ record, onRemove, removing }: RomRowProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { dir, name } = splitPath(record.path)
  const extension = extensionOf(name)
  const known = record.game !== null
  const tone: Tone = known ? (EXTENSION_TONE[extension] ?? 'violet') : 'neutral'

  return (
    <li
      className={cx('rom-row', toneClass(tone))}
      data-known={known || undefined}
      data-removing={removing || undefined}
    >
      <span className="rom-row__cart" aria-hidden="true">
        <span className="rom-row__ext">{extension.slice(0, 4).toUpperCase() || 'ROM'}</span>
      </span>

      <div className="rom-row__main">
        <p className="rom-row__title">
          <span className="rom-row__game">{known ? record.game : name}</span>
          {known && record.label !== null && (
            <>
              {' '}
              <span className="rom-row__label">{record.label}</span>
            </>
          )}
        </p>
        <p className="rom-row__meta">
          {known && <span className="rom-row__file">{name}</span>}
          {dir !== '' && (
            <span className="rom-row__dir" title={record.path}>
              <IconFolder aria-hidden="true" />
              <span className="rom-row__dir-text">{dir}</span>
            </span>
          )}
          <span className="rom-row__size">{formatSize(record.size, i18n.language)}</span>
          {!known && (
            <code className="rom-row__hash" title={record.md5}>
              {shortMd5(record.md5)}
            </code>
          )}
        </p>
      </div>

      <Badge
        tone={known ? 'green' : 'neutral'}
        outline={!known}
        title={t(known ? 'screens.vault.list.md5Verified' : 'screens.vault.list.md5Value', {
          md5: record.md5,
        })}
        className="rom-row__md5"
      >
        {known ? t('screens.vault.list.md5Ok') : t('screens.vault.list.md5Unknown')}
      </Badge>

      <Tooltip content={t('screens.vault.list.removeHint')}>
        <button
          type="button"
          className="rom-row__remove"
          aria-label={t('screens.vault.list.remove', { name })}
          disabled={removing}
          onClick={onRemove}
        >
          <IconTrash aria-hidden="true" />
        </button>
      </Tooltip>
    </li>
  )
}
