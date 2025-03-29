import * as esbuild from 'esbuild'

const result = await esbuild.build({
    entryPoints: ['extension/options.ts'],
    // assetNames: "assets/[name]",
    bundle: true,
    platform: 'browser',
    sourcemap: false,
    outdir: 'extension',
    // outExtension: { '.js': '.cjs' },
    // external: ["merge-deep", "puppeteer-stream"]
})

console.log(result)