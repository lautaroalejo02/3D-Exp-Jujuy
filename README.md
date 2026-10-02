# 3D-Exp-Jujuy

Maqueta 3D del relieve de Jujuy (educativa, secundaria). Sitio estático con
Vite + TypeScript strict + vgpu 0.5 (WebGPU). Ver `AGENTS.md` y
`odd/tasks/maqueta-base.md`.

## Comandos

- `npm install` — instalar dependencias
- `npm run dev` — servidor de desarrollo
- `npm run build` — typecheck + build a `dist/`
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — Vitest
- `npm run check:wgsl` — valida cada `src/**/*.wgsl` con `vgpu check`
