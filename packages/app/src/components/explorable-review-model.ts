export type ExplorableSection = {
  id: string
  title: string
  content: string
  children?: ExplorableSection[]
  meta?: unknown
}

function normalizedSectionText(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase()
}

function hasOwnSectionContent(section: ExplorableSection, parent: ExplorableSection | undefined) {
  if (!(section.title.trim() || section.content.trim())) return false
  if (!parent) return true
  const title = normalizedSectionText(section.title)
  const content = normalizedSectionText(section.content)
  return (!!title && title !== normalizedSectionText(parent.title)) || (!!content && content !== normalizedSectionText(parent.content))
}

export function visibleReviewSections(sections: ExplorableSection[]) {
  const visit = (section: ExplorableSection, parent?: ExplorableSection): ExplorableSection[] => {
    const children = (section.children ?? []).flatMap((child) => visit(child, section))
    if (!hasOwnSectionContent(section, parent)) return children
    if (!children.length) return [section]
    return [{ id: section.id, title: section.title, content: section.content, meta: section.meta, children }]
  }

  return sections.flatMap((section) => visit(section))
}
