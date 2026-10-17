// What a screen shows until its task replaces it (Tasks 24-32): its heading and a placeholder.
import { IconBarrierBlock } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { EmptyState, PixelPanel } from '../design/components'
import { ScreenHeader } from './ScreenHeader'

export interface ScreenStubProps {
  eyebrow: string
  title: string
  subtitle: string
}

export function ScreenStub({ eyebrow, title, subtitle }: ScreenStubProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <ScreenHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />
      <PixelPanel as="div" tone="yellow" padding="lg">
        <EmptyState
          tone="yellow"
          icon={<IconBarrierBlock />}
          title={t('shell.stub.title')}
          body={t('shell.stub.body')}
          headingLevel={2}
        />
      </PixelPanel>
    </>
  )
}
