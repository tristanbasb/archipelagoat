// Dev-only component gallery (/dev/gallery, unpackaged builds only). Its copy is hard-coded on
// purpose: it is a tool for developers, never shown to users, so it does not go through i18n.
import {
  IconBolt,
  IconDeviceGamepad2,
  IconDisc,
  IconDownload,
  IconFolderOpen,
  IconPlug,
  IconRefresh,
  IconTrash,
  IconUsersGroup,
  IconWorld,
} from '@tabler/icons-react'
import { useEffect, useState, type ReactNode } from 'react'
import { contrastRatio } from '../../design/contrast'
import { sfx, type SfxName } from '../../design/sfx'
import { DEFAULT_EFFECTS, EffectsProvider, type EffectsConfig } from '../../design/useEffectsPrefs'
import {
  Badge,
  Combobox,
  CopyField,
  CRTOverlay,
  Dropzone,
  EmptyState,
  ErrorPanel,
  Kbd,
  Modal,
  NeonButton,
  PixelPanel,
  PlayerCard,
  ProgressBar,
  Segmented,
  Select,
  Slider,
  Spinner,
  StatTile,
  StatusPill,
  Stepper,
  Tabs,
  Terminal,
  ToastProvider,
  Toggle,
  Tooltip,
  TrustBadge,
  useToast,
  WeightSlider,
  type TerminalLine,
} from '../../design/components'
import './Gallery.css'

const SECTIONS = [
  { id: 'colors', label: 'Couleurs' },
  { id: 'type', label: 'Typographie' },
  { id: 'effects', label: 'Effets' },
  { id: 'buttons', label: 'Boutons' },
  { id: 'players', label: 'Cartes joueur' },
  { id: 'tiles', label: 'Panneaux et tuiles' },
  { id: 'labels', label: 'Statuts et badges' },
  { id: 'progress', label: 'Progression' },
  { id: 'choices', label: 'Choix' },
  { id: 'search', label: 'Recherche et valeurs' },
  { id: 'weights', label: 'Poids' },
  { id: 'files', label: 'Copie et dépôt' },
  { id: 'console', label: 'Console' },
  { id: 'tabs', label: 'Onglets' },
  { id: 'overlays', label: 'Superpositions' },
  { id: 'states', label: 'États vides et erreurs' },
  { id: 'sounds', label: 'Sons' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id: SectionId
  eyebrow: string
  title: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <PixelPanel id={`gallery-${id}`} eyebrow={eyebrow} title={title} typewriter className="gallery__section">
      {children}
    </PixelPanel>
  )
}

function Row({ children, label }: { children: ReactNode; label?: string }): React.JSX.Element {
  return (
    <div className="gallery__row">
      {label !== undefined && <span className="gallery__row-label">{label}</span>}
      <div className="gallery__row-items">{children}</div>
    </div>
  )
}

// ---- Colors ------------------------------------------------------------------------------------

const SWATCHES: { group: string; tokens: [name: string, hex: string][] }[] = [
  {
    group: 'Fonds',
    tokens: [
      ['--bg-0', '#07070C'],
      ['--bg-1', '#0B0B12'],
      ['--bg-2', '#111118'],
      ['--bg-3', '#1A1A24'],
      ['--line', '#26262F'],
      ['--line-strong', '#3A3A48'],
    ],
  },
  {
    group: 'Texte',
    tokens: [
      ['--text', '#F5F3FF'],
      ['--text-dim', '#9D9DB0'],
      ['--text-mute', '#5B5B6B'],
    ],
  },
  {
    group: 'Néons',
    tokens: [
      ['--neon-violet', '#A855F7'],
      ['--neon-cyan', '#22D3EE'],
      ['--neon-yellow', '#FACC15'],
      ['--neon-pink', '#F43F5E'],
      ['--neon-green', '#4ADE80'],
      ['--neon-magenta', '#EE00EE'],
    ],
  },
  {
    group: 'Objets Archipelago',
    tokens: [
      ['--ap-progression', '#AF99EF'],
      ['--ap-useful', '#6D8BE8'],
      ['--ap-trap', '#FA8072'],
      ['--ap-filler', '#00EEEE'],
    ],
  },
]

function Colors(): React.JSX.Element {
  return (
    <div className="gallery__swatch-groups">
      {SWATCHES.map(({ group, tokens }) => (
        <div key={group} className="gallery__swatch-group">
          <span className="gallery__swatch-title">{group}</span>
          <div className="gallery__swatches">
            {tokens.map(([name, hex]) => (
              <div key={name} className="gallery__swatch">
                <span className="gallery__swatch-chip" style={{ background: `var(${name})` }} />
                <code>{name}</code>
                <span className="gallery__swatch-meta">
                  {hex} · {contrastRatio(hex, '#07070C').toFixed(1)}:1
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---- Type --------------------------------------------------------------------------------------

function Typography(): React.JSX.Element {
  return (
    <div className="gallery__type">
      <div className="gallery__type-display">
        <span className="t-display tone-violet text-glow" style={{ fontSize: 20, color: 'var(--tone-ink)' }}>
          INSERT COIN
        </span>
        <span className="t-display" style={{ color: 'var(--neon-yellow)' }}>
          PLAYER 1 · PRESS START
        </span>
        <span className="t-display t-dim">Press Start 2P · 10 px minimum, étiquettes d’arcade seulement</span>
      </div>
      <div className="gallery__type-scale">
        {[28, 20, 16, 14, 13, 12].map((size) => (
          <p key={size} className={`t-${size}`}>
            <span className="gallery__type-size">{size}</span>
            Générer une partie à 8 joueurs
          </p>
        ))}
      </div>
      <p className="t-14">
        Curseur clignotant
        <span className="blink-cursor tone-yellow" aria-hidden="true" />
      </p>
    </div>
  )
}

// ---- Effects -----------------------------------------------------------------------------------

function EffectsDemo({
  effects,
  onChange,
}: {
  effects: EffectsConfig
  onChange: (effects: EffectsConfig) => void
}): React.JSX.Element {
  const set = (key: keyof EffectsConfig) => (on: boolean) => onChange({ ...effects, [key]: on })
  return (
    <div className="gallery__effects">
      <div className="gallery__fx-controls">
        <Toggle
          label="CRT"
          description="Lignes de balayage, vignette"
          checked={effects.crt}
          onChange={set('crt')}
        />
        <Toggle label="Glow" description="Halos néon" checked={effects.glow} onChange={set('glow')} />
        <Toggle
          label="Animations"
          description="Mouvements et transitions"
          checked={effects.animations}
          onChange={set('animations')}
        />
        <Toggle
          label="Sons"
          description="Bips 8-bit (coupés par défaut)"
          checked={effects.sounds}
          onChange={set('sounds')}
          tone="yellow"
        />
      </div>
      <div className="gallery__fx-samples">
        <div className="gallery__fx-sample pixel-border tone-violet">
          <span className="t-display">.pixel-border</span>
        </div>
        <div className="gallery__fx-sample gallery__fx-box glow-violet">
          <span className="t-display">.glow-violet</span>
        </div>
        <div className="gallery__fx-sample gallery__fx-box glow-cyan">
          <span className="t-display">.glow-cyan</span>
        </div>
        <div className="gallery__fx-sample gallery__fx-box scanlines">
          <span className="t-display">.scanlines</span>
        </div>
      </div>
    </div>
  )
}

// ---- Data ----------------------------------------------------------------------------------------

const STEPS = [
  { id: 'players', label: 'Joueurs' },
  { id: 'check', label: 'Vérification' },
  { id: 'rules', label: 'Règles' },
  { id: 'generate', label: 'Génération' },
  { id: 'host', label: 'Hébergement' },
]

const GAMES = [
  { value: 'A Link to the Past', label: 'A Link to the Past', hint: 'SNES' },
  { value: 'Ocarina of Time', label: 'Ocarina of Time', hint: 'N64' },
  { value: 'Super Metroid', label: 'Super Metroid', hint: 'SNES' },
  { value: 'Pokémon Red and Blue', label: 'Pokémon Red and Blue', hint: 'GB' },
  { value: 'Hollow Knight', label: 'Hollow Knight', hint: 'PC' },
  { value: 'Celeste 64', label: 'Celeste 64', hint: 'PC' },
  { value: 'Stardew Valley', label: 'Stardew Valley', hint: 'PC' },
  { value: 'The Messenger', label: 'The Messenger', hint: 'PC' },
]

const FEED: TerminalLine[] = [
  { text: 'Archipelago 0.6.8 · serveur prêt sur le port 38281', tone: 'info' },
  { text: 'Tristan (Team #1) playing A Link to the Past has joined.', tone: 'dim' },
  { text: 'Tristan sent Hookshot to Alice (Kakariko Well - Top)', tone: 'progression' },
  { text: 'Alice sent Bow to Tristan (Spiral Cave)', tone: 'self' },
  { text: 'Bob sent Magic Upgrade (1/2) to Alice (Ether Tablet)', tone: 'useful' },
  { text: 'Bob sent 20 Rupees to Alice (Lost Woods Hideout)', tone: 'filler' },
  { text: 'Alice sent Ice Trap to Bob (Ice Palace - Map Chest)', tone: 'trap' },
  { text: 'Bob a perdu la connexion (délai dépassé)', tone: 'warn' },
  { text: 'Alice has completed their goal.', tone: 'ok' },
  { text: 'Commande inconnue : /relese', tone: 'error' },
]

// ---- Overlays ------------------------------------------------------------------------------------

function ToastButtons(): React.JSX.Element {
  const toast = useToast()
  return (
    <Row label="Toast">
      <NeonButton
        variant="secondary"
        size="sm"
        onClick={() =>
          toast.push({
            tone: 'ok',
            title: 'Partie générée',
            body: 'AP_48213.zip est prêt dans le dossier de la partie.',
          })
        }
      >
        Succès
      </NeonButton>
      <NeonButton
        variant="secondary"
        size="sm"
        onClick={() =>
          toast.push({
            tone: 'info',
            title: 'Archipelago 0.6.9 est disponible',
            action: { label: 'Voir les notes', onClick: () => undefined },
          })
        }
      >
        Info
      </NeonButton>
      <NeonButton
        variant="secondary"
        size="sm"
        onClick={() => toast.push({ tone: 'warn', title: 'Redémarre les programmes Archipelago ouverts' })}
      >
        Alerte
      </NeonButton>
      <NeonButton
        variant="danger"
        size="sm"
        onClick={() =>
          toast.push({
            tone: 'error',
            title: 'Le serveur s’est arrêté',
            body: 'Port 38281 déjà utilisé.',
            duration: 0,
          })
        }
      >
        Erreur (reste affichée)
      </NeonButton>
    </Row>
  )
}

function TrustModal({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const [understood, setUnderstood] = useState(false)
  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="APWORLD"
      title="Installer Hollow Knight 0.4.5 ?"
      closeLabel="Fermer"
      footer={
        <>
          <NeonButton variant="ghost" onClick={onClose}>
            Annuler
          </NeonButton>
          <NeonButton disabled={!understood} onClick={onClose}>
            Installer
          </NeonButton>
        </>
      }
    >
      <div className="gallery__stack">
        <p>
          Un APWorld est du code Python qu’Archipelago exécute. Installe seulement ceux en qui tu as
          confiance.
        </p>
        <Row>
          <TrustBadge
            tier="indexed-verified"
            label="Index vérifié"
            description="Entrée de l’index communautaire, sha256 vérifié"
          />
          <Badge>par Ijwu</Badge>
        </Row>
        <CopyField
          label="sha256"
          value="9f2c4e1ab07d33c8e5a1f0b2d4c6e8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6"
          copyLabel="Copier"
          copiedLabel="Copié"
        />
        <Toggle label="J’ai compris" checked={understood} onChange={setUnderstood} />
      </div>
    </Modal>
  )
}

// ---- Gallery -------------------------------------------------------------------------------------

const SOUNDS: SfxName[] = ['blip', 'confirm', 'coin', 'success', 'error']

function GalleryContent({
  effects,
  onEffectsChange,
}: {
  effects: EffectsConfig
  onEffectsChange: (effects: EffectsConfig) => void
}): React.JSX.Element {
  const [step, setStep] = useState(2)
  const [download, setDownload] = useState<number | null>(null)
  const [mode, setMode] = useState<'simple' | 'weighted' | 'raw'>('weighted')
  const [goal, setGoal] = useState<'ganon' | 'pedestal' | 'triforce'>('ganon')
  const [language, setLanguage] = useState<'fr' | 'en' | 'auto'>('auto')
  const [deathLink, setDeathLink] = useState(true)
  const [game, setGame] = useState<string | null>('A Link to the Past')
  const [shopPrice, setShopPrice] = useState(50)
  const [crystals, setCrystals] = useState(7)
  const [weights, setWeights] = useState<Record<string, number>>({
    easy: 10,
    normal: 50,
    hard: 25,
    expert: 0,
  })
  const [worldsTab, setWorldsTab] = useState<'installed' | 'catalog' | 'broken'>('installed')
  const [feed, setFeed] = useState<TerminalLine[]>(FEED)
  const [history, setHistory] = useState<string[]>(['/players', '/hint Hookshot'])
  const [modalOpen, setModalOpen] = useState(false)
  const [dropped, setDropped] = useState<string[]>([])

  // A fake download for the live progress bar.
  useEffect(() => {
    if (download === null || download >= 100) return
    const timer = window.setTimeout(() => setDownload((value) => Math.min(100, (value ?? 0) + 3.7)), 120)
    return () => window.clearTimeout(timer)
  }, [download])

  const jump = (id: SectionId): void => {
    document
      .getElementById(`gallery-${id}`)
      ?.scrollIntoView({ behavior: effects.animations ? 'smooth' : 'auto' })
  }

  return (
    <div className="gallery grid-bg">
      <CRTOverlay />
      <header className="gallery__header">
        <div className="gallery__brand">
          <span className="gallery__logo t-display tone-violet">
            ARCHIPELA<span className="gallery__logo-goat">GOAT</span>
          </span>
          <h1 className="gallery__title">
            Design system <span className="gallery__title-accent">Arcade néon</span>
          </h1>
        </div>
        <Badge tone="yellow">dev · non empaqueté</Badge>
      </header>

      <div className="gallery__layout">
        <nav className="gallery__nav" aria-label="Sections">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              className="gallery__nav-link"
              onClick={() => jump(section.id)}
            >
              {section.label}
            </button>
          ))}
        </nav>

        <main className="gallery__main">
          <Section id="colors" eyebrow="TOKENS" title="Couleurs">
            <Colors />
          </Section>

          <Section id="type" eyebrow="TOKENS" title="Typographie">
            <Typography />
          </Section>

          <Section id="effects" eyebrow="FX" title="Effets · CRTOverlay">
            <EffectsDemo effects={effects} onChange={onEffectsChange} />
          </Section>

          <Section id="buttons" eyebrow="ACTIONS" title="NeonButton">
            <div className="gallery__stack">
              {(['primary', 'secondary', 'ghost', 'danger'] as const).map((variant) => (
                <Row key={variant} label={variant}>
                  <NeonButton variant={variant} size="sm">
                    Petit
                  </NeonButton>
                  <NeonButton variant={variant} icon={<IconDownload />}>
                    Installer
                  </NeonButton>
                  <NeonButton variant={variant} size="lg">
                    Générer la partie
                  </NeonButton>
                  <NeonButton variant={variant} disabled>
                    Désactivé
                  </NeonButton>
                </Row>
              ))}
              <Row label="états">
                <NeonButton loading loadingLabel="Téléchargement…">
                  Installer
                </NeonButton>
                <NeonButton variant="secondary" loading>
                  Vérification
                </NeonButton>
                <NeonButton variant="ghost" icon={<IconRefresh />} aria-label="Actualiser" />
                <NeonButton arcade size="lg" icon={<IconBolt />}>
                  INSERT COIN
                </NeonButton>
                <NeonButton arcade size="lg" variant="secondary">
                  JOUER
                </NeonButton>
              </Row>
            </div>
          </Section>

          <Section id="players" eyebrow="ACCUEIL" title="PlayerCard">
            <div className="gallery__grid-2">
              <PlayerCard
                player={1}
                label="PLAYER 1"
                title="Organiser une partie"
                subtitle="Rassemble les YAML, génère la seed et héberge la room."
                cta="PRESS START"
                icon={<IconUsersGroup />}
                onClick={() => jump('progress')}
              />
              <PlayerCard
                player={2}
                label="PLAYER 2"
                title="Rejoindre une partie"
                subtitle="Colle un lien de room ou dépose ton patch, puis joue."
                cta="PRESS START"
                icon={<IconDeviceGamepad2 />}
                onClick={() => jump('files')}
              />
            </div>
          </Section>

          <Section id="tiles" eyebrow="ACCUEIL" title="PixelPanel · StatTile">
            <div className="gallery__stack">
              <div className="gallery__grid-4">
                <StatTile
                  icon={<IconBolt />}
                  label="Archipelago"
                  value="0.6.8"
                  hint={<StatusPill status="ok" label="À jour" />}
                />
                <StatTile
                  icon={<IconWorld />}
                  tone="cyan"
                  label="Mondes"
                  value="42 installés"
                  hint={<StatusPill status="warn" label="2 cassés" />}
                  onClick={() => jump('tabs')}
                />
                <StatTile
                  icon={<IconDisc />}
                  tone="yellow"
                  label="ROMs"
                  value="3 reconnues"
                  hint={<StatusPill status="info" label="1 à vérifier" />}
                />
                <StatTile
                  icon={<IconPlug />}
                  tone="pink"
                  label="BizHawk"
                  value="Absent"
                  hint={<StatusPill status="error" label="Requis pour 5 jeux" />}
                  onClick={() => undefined}
                />
              </div>
              <div className="gallery__grid-3">
                <PixelPanel
                  title="Parties récentes"
                  eyebrow="SAVE"
                  headingLevel={3}
                  actions={
                    <NeonButton variant="ghost" size="sm">
                      Tout voir
                    </NeonButton>
                  }
                >
                  <p className="t-13 t-dim">Soirée du vendredi · 6 joueurs · il y a 2 jours</p>
                </PixelPanel>
                <PixelPanel title="Panneau cyan" tone="cyan" headingLevel={3}>
                  <p className="t-13 t-dim">Bordure teintée, sans halo.</p>
                </PixelPanel>
                <PixelPanel title="Panneau lumineux" tone="violet" glow headingLevel={3}>
                  <p className="t-13 t-dim">glow : la bordure s’allume.</p>
                </PixelPanel>
              </div>
            </div>
          </Section>

          <Section id="labels" eyebrow="ÉTIQUETTES" title="StatusPill · Badge · TrustBadge · Kbd">
            <div className="gallery__stack">
              <Row label="StatusPill">
                <StatusPill status="ok" label="Connecté" />
                <StatusPill status="warn" label="Absent" />
                <StatusPill status="error" label="Hors ligne" />
                <StatusPill status="info" label="archipelago.gg" />
                <StatusPill status="busy" label="Génération" />
                <StatusPill status="idle" label="Serveur arrêté" />
              </Row>
              <Row label="Badge">
                <Badge>neutre</Badge>
                <Badge tone="violet">progression</Badge>
                <Badge tone="cyan">PopTracker</Badge>
                <Badge tone="yellow">requiert une ROM</Badge>
                <Badge tone="green">but atteint</Badge>
                <Badge tone="pink">18+</Badge>
                <Badge tone="magenta">toi</Badge>
              </Row>
              <Row label="TrustBadge">
                <TrustBadge tier="core" label="Intégré" description="Livré avec Archipelago" />
                <TrustBadge
                  tier="indexed-verified"
                  label="Index vérifié"
                  description="Index communautaire, sha256 vérifié"
                />
                <TrustBadge
                  tier="wiki-release"
                  label="Release du wiki"
                  description="Lien de release du wiki, non vérifié"
                />
                <TrustBadge
                  tier="unknown"
                  label="Source inconnue"
                  description="Fichier local ou lien direct"
                />
              </Row>
              <Row label="Kbd">
                <span className="gallery__kbd">
                  <Kbd>Ctrl</Kbd>+<Kbd>3</Kbd> Rejoindre
                </span>
                <span className="gallery__kbd">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd> historique de la console
                </span>
              </Row>
            </div>
          </Section>

          <Section id="progress" eyebrow="ASSISTANT" title="Stepper · ProgressBar · Spinner">
            <div className="gallery__stack">
              <Stepper label="Étapes de la partie" steps={STEPS} current={STEPS[step]?.id ?? 'players'} />
              <Row>
                <NeonButton
                  variant="ghost"
                  size="sm"
                  disabled={step === 0}
                  onClick={() => setStep((s) => s - 1)}
                >
                  Précédent
                </NeonButton>
                <NeonButton
                  variant="secondary"
                  size="sm"
                  disabled={step === STEPS.length - 1}
                  onClick={() => setStep((s) => s + 1)}
                >
                  Suivant
                </NeonButton>
              </Row>
              <div className="gallery__grid-2">
                <ProgressBar label="Téléchargement d’Archipelago 0.6.8" percent={download ?? 0} tone="cyan" />
                <ProgressBar label="Génération · étape 3 sur 5" percent={null} />
                <ProgressBar label="Vérification sha256" percent={100} tone="green" />
                <ProgressBar label="Vie (10 segments)" percent={30} segments={10} tone="pink" />
              </div>
              <Row>
                <NeonButton
                  variant="secondary"
                  size="sm"
                  icon={<IconDownload />}
                  onClick={() => setDownload(0)}
                >
                  Simuler un téléchargement
                </NeonButton>
                <Spinner label="Recherche d’Archipelago…" />
                <Spinner size="sm" />
              </Row>
            </div>
          </Section>

          <Section id="choices" eyebrow="FORMULAIRES" title="Toggle · Segmented · Select">
            <div className="gallery__grid-2">
              <div className="gallery__stack">
                <Toggle
                  label="DeathLink"
                  description="Quand un joueur meurt, tout le monde meurt"
                  checked={deathLink}
                  onChange={setDeathLink}
                />
                <Toggle
                  label="Option verrouillée"
                  description="Imposée par le preset"
                  checked
                  disabled
                  onChange={() => undefined}
                />
                <Toggle label="Mondes 18+" checked={false} tone="pink" onChange={() => undefined} />
              </div>
              <div className="gallery__stack">
                <Segmented
                  label="Mode"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'simple', label: 'Simple' },
                    { value: 'weighted', label: 'Pondéré' },
                    { value: 'raw', label: 'YAML brut' },
                  ]}
                />
                <Segmented
                  label="Objectif"
                  size="sm"
                  value={goal}
                  onChange={setGoal}
                  options={[
                    { value: 'ganon', label: 'Ganon' },
                    { value: 'pedestal', label: 'Piédestal' },
                    { value: 'triforce', label: 'Triforce' },
                  ]}
                />
                <Select
                  label="Langue"
                  value={language}
                  onChange={setLanguage}
                  options={[
                    { value: 'auto', label: 'Automatique (système)' },
                    { value: 'fr', label: 'Français' },
                    { value: 'en', label: 'English' },
                  ]}
                />
              </div>
            </div>
          </Section>

          <Section id="search" eyebrow="FORMULAIRES" title="Combobox · Slider">
            <div className="gallery__grid-2">
              <Combobox
                label="Jeu"
                placeholder="Chercher un monde installé"
                emptyLabel="Aucun monde ne correspond"
                options={GAMES}
                value={game}
                onChange={setGame}
              />
              <div className="gallery__stack">
                <Slider
                  label="Prix de la boutique (%)"
                  min={0}
                  max={400}
                  step={10}
                  value={shopPrice}
                  onChange={setShopPrice}
                  withInput
                  marks={[
                    { value: 0, label: 'gratuit' },
                    { value: 100, label: 'normal' },
                    { value: 400, label: 'cher' },
                  ]}
                />
                <Slider
                  label="Cristaux pour la tour"
                  min={0}
                  max={7}
                  value={crystals}
                  onChange={setCrystals}
                  tone="cyan"
                />
              </div>
            </div>
          </Section>

          <Section id="weights" eyebrow="STUDIO YAML" title="WeightSlider">
            <WeightSlider
              label="Difficulté"
              weights={weights}
              onChange={setWeights}
              optionLabels={{ easy: 'Facile', normal: 'Normal', hard: 'Difficile', expert: 'Expert' }}
            />
          </Section>

          <Section id="files" eyebrow="FICHIERS" title="CopyField · Dropzone">
            <div className="gallery__grid-2">
              <div className="gallery__stack">
                <CopyField
                  label="Adresse du serveur"
                  value="archipelago.gg:38281"
                  copyLabel="Copier"
                  copiedLabel="Copié"
                />
                <CopyField
                  label="Mot de passe du serveur"
                  value="goat-8bit-2026"
                  secret
                  copyLabel="Copier"
                  copiedLabel="Copié"
                  revealLabel="Afficher le mot de passe"
                  hideLabel="Masquer le mot de passe"
                />
                {dropped.length > 0 && <p className="t-12 t-dim">Déposé : {dropped.join(', ')}</p>}
              </div>
              <Dropzone
                accept={['.yaml', '.yml']}
                title="Dépose les YAML des joueurs"
                hint="Fichiers .yaml ou .yml, un par joueur"
                browseLabel="Parcourir"
                icon={<IconFolderOpen />}
                onFiles={setDropped}
                onBrowse={() => undefined}
              />
            </div>
          </Section>

          <Section id="console" eyebrow="PARTIE EN COURS" title="Terminal">
            <Terminal
              label="Console du serveur · room 7f3a"
              inputLabel="Commande du serveur"
              placeholder="/help"
              lines={feed}
              history={history}
              onCommand={(command) => {
                setHistory((list) => [...list, command])
                setFeed((lines) => [
                  ...lines,
                  { text: `> ${command}`, tone: 'dim' },
                  { text: 'Commande envoyée au serveur.' },
                ])
              }}
            />
          </Section>

          <Section id="tabs" eyebrow="MONDES" title="Tabs">
            <Tabs
              label="Mondes"
              value={worldsTab}
              onChange={setWorldsTab}
              tabs={[
                { id: 'installed', label: 'Installés', badge: 42 },
                { id: 'catalog', label: 'Catalogue', badge: 318 },
                { id: 'broken', label: 'Cassés', badge: 2 },
              ]}
            >
              <p className="t-13 t-dim">
                {worldsTab === 'installed'
                  ? '42 mondes dans custom_worlds.'
                  : worldsTab === 'catalog'
                    ? '318 mondes dans le catalogue communautaire.'
                    : '2 mondes ne se chargent pas avec Archipelago 0.6.8.'}
              </p>
            </Tabs>
          </Section>

          <Section id="overlays" eyebrow="SUPERPOSITIONS" title="Modal · Toast · Tooltip">
            <div className="gallery__stack">
              <Row label="Modal">
                <NeonButton onClick={() => setModalOpen(true)}>Ouvrir l’écran de confiance</NeonButton>
              </Row>
              <ToastButtons />
              <Row label="Tooltip">
                <Tooltip content="Ouvre le dossier custom_worlds">
                  <NeonButton variant="ghost" icon={<IconFolderOpen />}>
                    Survole-moi
                  </NeonButton>
                </Tooltip>
                <Tooltip content="Supprime le monde et garde une sauvegarde" side="bottom">
                  <NeonButton variant="danger" size="sm" icon={<IconTrash />}>
                    En dessous
                  </NeonButton>
                </Tooltip>
              </Row>
            </div>
            <TrustModal open={modalOpen} onClose={() => setModalOpen(false)} />
          </Section>

          <Section id="states" eyebrow="ÉTATS" title="EmptyState · ErrorPanel">
            <div className="gallery__grid-2">
              <PixelPanel as="div" padding="sm">
                <EmptyState
                  title="Aucun monde installé"
                  body="Dépose un fichier .apworld n’importe où dans l’app, ou parcours le catalogue."
                  action={<NeonButton variant="secondary">Ouvrir le catalogue</NeonButton>}
                />
              </PixelPanel>
              <ErrorPanel
                title="La génération a échoué"
                body="Le YAML de Bob demande le monde « Celeste 64 », qui n’est pas installé. Installe-le puis relance."
                detailLabel="Détails techniques"
                detail={
                  'Traceback (most recent call last):\n  File "Generate.py", line 512, in roll_settings\nException: No world found to handle game Celeste 64'
                }
                actions={
                  <>
                    <NeonButton size="sm">Installer Celeste 64</NeonButton>
                    <NeonButton variant="ghost" size="sm">
                      Ouvrir le log
                    </NeonButton>
                  </>
                }
              />
            </div>
          </Section>

          <Section id="sounds" eyebrow="SFX" title="Sons">
            <div className="gallery__stack">
              <p className="t-13 t-dim">
                Synthèse WebAudio, aucun fichier. Muets tant que « Sons » est coupé dans les effets.
              </p>
              <Row>
                {SOUNDS.map((name) => (
                  <NeonButton
                    key={name}
                    variant="secondary"
                    size="sm"
                    sound={false}
                    onClick={() => sfx.play(name)}
                  >
                    {name}
                  </NeonButton>
                ))}
              </Row>
            </div>
          </Section>
        </main>
      </div>
    </div>
  )
}

export function Gallery(): React.JSX.Element {
  const [effects, setEffects] = useState<EffectsConfig>(DEFAULT_EFFECTS)
  return (
    <EffectsProvider effects={effects}>
      <ToastProvider label="Notifications" closeLabel="Fermer">
        <GalleryContent effects={effects} onEffectsChange={setEffects} />
      </ToastProvider>
    </EffectsProvider>
  )
}
