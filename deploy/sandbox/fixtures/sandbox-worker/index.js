export const name = '@local/sandbox-worker'

export function apply(ctx) {
  console.log('[sandbox-worker] applied')
  ctx.effect(() => {
    console.log('[sandbox-worker] active')
    return () => console.log('[sandbox-worker] inactive')
  })
}
