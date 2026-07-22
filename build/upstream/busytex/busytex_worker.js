// SPDX-License-Identifier: MIT
// Vendored from busytex/busytex <https://github.com/busytex/busytex>
//   at commit f2bd7b11ee1b7b093638321c1f3e5d70389d307b
//   (pinned in build/sources/pins.lock; commit hard-verified at fetch time).
// License: MIT, per the upstream README "License" section; the upstream
//   repository has no top-level LICENSE file. See THIRD_PARTY_NOTICES.md.
// Vendored UNMODIFIED (M0 item 3): the file body below is byte-for-byte
//   identical to the pinned commit; the only change is this provenance header.
// build/upstream/ is an M0-only staging area (see build/upstream/README.md),
//   dissolved into build/engines/ etc. at M1. Do not modify vendored files
//   here except via documented item-4 patches.
// Per-file manifest with sha256: build/upstream/busytex/PROVENANCE.md.
importScripts('busytex_pipeline.js');

self.pipeline = null;

onmessage = async ({data : {files, main_tex_path, bibtex, busytex_wasm, busytex_js, preload_data_packages_js, data_packages_js, texmf_local, preload, verbose, driver}}) => 
{
    // TODO: cache data packages from here? https://developer.mozilla.org/en-US/docs/Web/API/Cache
    
    if(busytex_wasm && busytex_js && preload_data_packages_js)
    {
        try
        {
            self.pipeline = new BusytexPipeline(busytex_js, busytex_wasm, data_packages_js, preload_data_packages_js, texmf_local, msg => postMessage({print : msg}), applet_versions => postMessage({ initialized : applet_versions }), preload, BusytexPipeline.ScriptLoaderWorker);
        }
        catch(err)
        {
            postMessage({exception: 'Exception during initialization: ' + err.toString() + '\nStack:\n' + err.stack});
        }
    }
    else if(files && self.pipeline)
    {
        try
        {
            postMessage(await self.pipeline.compile(files, main_tex_path, bibtex, verbose, driver, data_packages_js))
        }
        catch(err)
        {
            postMessage({exception: 'Exception during compilation: ' + err.toString() + '\nStack:\n' + err.stack});
        }
    }
};
