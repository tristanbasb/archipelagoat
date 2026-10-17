import { i18n } from '@renderer/i18n'
import { stageLabel, taskLabel } from '@renderer/lib/task-stages'
import type { TaskKind } from '@shared/types'

const progress = (kind: TaskKind, stage: string) => ({ kind, stage })

describe('task stage labels', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr')
  })

  it('labels the stages of the BizHawk install and the ROM scan', () => {
    expect(stageLabel(progress('bizhawk-install', 'release'), i18n.t)).toBe('Recherche de la version')
    expect(stageLabel(progress('bizhawk-install', 'extract'), i18n.t)).toBe('Extraction des fichiers')
    expect(stageLabel(progress('rom-scan', 'list'), i18n.t)).toBe('Recherche des fichiers')
    expect(stageLabel(progress('rom-scan', 'hash'), i18n.t)).toBe('Calcul des empreintes')
  })

  it('labels the stages of the templates and the uninstall, in both languages', async () => {
    expect(taskLabel(progress('templates', 'scan'), i18n.t)).toBe(
      'Génération des templates · Vérification des mondes installés',
    )
    expect(stageLabel(progress('ap-uninstall', 'uninstall'), i18n.t)).toBe('Désinstallation')

    await i18n.changeLanguage('en')
    expect(taskLabel(progress('templates', 'generate'), i18n.t)).toBe(
      'Generating templates · Writing the templates',
    )
    expect(stageLabel(progress('ap-uninstall', 'uninstall'), i18n.t)).toBe('Uninstalling')
  })

  it("keeps the generation's own `done` apart from the other tasks' one", () => {
    expect(stageLabel(progress('generate', 'done'), i18n.t)).toBe('Terminé')
    expect(stageLabel(progress('templates', 'done'), i18n.t)).toBe('Terminé')
    expect(i18n.exists('taskStages.done')).toBe(true)
  })

  it('has no label before the first progress or for a stage it does not know', () => {
    expect(stageLabel(null, i18n.t)).toBeNull()
    expect(stageLabel(progress('templates', 'init'), i18n.t)).toBeNull()
    expect(taskLabel(progress('templates', 'nope'), i18n.t)).toBe('Génération des templates')
  })
})
