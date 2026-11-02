import { defineConfig } from 'vitepress';

export default defineConfig({
  base: '/docs/',
  lang: 'es-MX',
  title: 'DBML Studio',
  description: 'Manual, sintaxis y arquitectura de DBML Studio.',
  cleanUrls: true,
  outDir: '../dist/docs',
  markdown: { languageAlias: { dbml: 'sql' } },
  themeConfig: {
    siteTitle: 'DBML Studio',
    nav: [
      { text: 'Inicio', link: '/' },
      { text: 'Manual de usuario', link: '/manual-usuario' },
      { text: 'Referencia', link: '/referencia-sintaxis' },
    ],
    sidebar: [
      {
        text: 'Primeros pasos',
        items: [
          { text: 'Inicio', link: '/' },
          { text: 'Manual de usuario', link: '/manual-usuario' },
        ],
      },
      {
        text: 'Referencia',
        items: [
          { text: 'Sintaxis y manifiesto', link: '/referencia-sintaxis' },
          { text: 'Arquitectura', link: '/arquitectura' },
          { text: 'Guía para desarrolladores', link: '/guia-desarrollador' },
        ],
      },
      {
        text: 'Ejemplos',
        items: [{ text: 'Proyectos funcionales', link: '/ejemplos/README' }],
      },
    ],
    outline: { label: 'En esta página', level: [2, 3] },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: 'Buscar', buttonAriaLabel: 'Buscar en la documentación' },
          modal: {
            noResultsText: 'No hay resultados',
            resetButtonTitle: 'Limpiar búsqueda',
            footer: {
              selectText: 'seleccionar',
              navigateText: 'navegar',
              closeText: 'cerrar',
            },
          },
        },
      },
    },
    docFooter: { prev: 'Anterior', next: 'Siguiente' },
    sidebarMenuLabel: 'Índice',
    returnToTopLabel: 'Volver arriba',
    darkModeSwitchLabel: 'Apariencia',
    lightModeSwitchTitle: 'Cambiar a tema claro',
    darkModeSwitchTitle: 'Cambiar a tema oscuro',
    footer: { message: 'Documentación mantenida junto al código fuente.' },
  },
});
