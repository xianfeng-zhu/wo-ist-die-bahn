// Small, local SVG icons: no runtime icon font or remote asset dependency.
const paths = {
  train: 'M7 3h10a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z M4 11h16 M8 3v8 M16 3v8 M8 16h.01 M16 16h.01 M8 20l-2 2 M16 20l2 2',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z M16 16l5 5',
  filters: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  close: 'M6 6l12 12 M18 6 6 18',
  back: 'M14 5l-7 7 7 7 M7 12h14',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
} as const

export function icon(name: keyof typeof paths): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.7')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('icon')
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', paths[name])
  svg.append(path)
  return svg
}
