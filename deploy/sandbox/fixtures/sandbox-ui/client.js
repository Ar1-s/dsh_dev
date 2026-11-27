window.__ModuleLoader__.load({
  id: '@local/sandbox-ui',
  factory(require) {
    const React = require('react')
    const PANEL_ID = 'sandbox'

    function SandboxPanel() {
      return React.createElement(
        'section',
        {
          'data-sandbox-ui': 'ready',
          style: {
            boxSizing: 'border-box',
            margin: '0 auto',
            maxWidth: '720px',
            padding: '32px 24px',
          },
        },
        React.createElement('h2', null, 'Sandbox UI'),
        React.createElement(
          'p',
          null,
          'This panel is contributed by @local/sandbox-ui, one of the three T1 sandbox fixtures.',
        ),
      )
    }

    function SandboxIcon() {
      return React.createElement('span', { 'aria-hidden': 'true' }, 'S')
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, SandboxPanel),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 30,
              label: () => 'Sandbox',
            },
            SandboxIcon,
          ),
        )
      },
    }
  },
})
