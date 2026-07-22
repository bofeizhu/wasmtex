/*
 * SPDX-License-Identifier: MIT
 * DERIVED WORK (DESIGN.md §2.1). Derived from busytex/busytex
 *   <https://github.com/busytex/busytex> at commit
 *   f2bd7b11ee1b7b093638321c1f3e5d70389d307b (MIT; pinned in
 *   build/sources/pins.lock [busytex], hard-verified at fetch time). The
 *   upstream repository has no top-level LICENSE file; its README "License"
 *   section is the statement of record. See THIRD_PARTY_NOTICES.md / NOTICE.
 *
 * This is OUR maintained multicall dispatcher, forked from the upstream
 *   busytex.c at the WasmTeX TL-2026 rebase (M2 item 3), when build/upstream/
 *   was dissolved into build/engines/. Substantive modifications vs upstream:
 *     - Dropped LuaTeX: removed the `#ifdef BUSYTEX_LUATEX` extern for
 *       busymain_luahbtex, the `luatex`/`luahbtex` lines from the applet
 *       listing, and the `luahbtex`/`luahblatex` argv[1] dispatch. LuaTeX
 *       leaves v1 scope and the annual-rebase surface (DESIGN.md §9 amendment).
 *   The retained applet set is XeTeX + pdfTeX + bibtex8 + xdvipdfmx +
 *   makeindex + the kpathsea tools (DESIGN.md §3).
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <sys/stat.h>

#ifdef __cplusplus
#define extern  extern "C"
#endif

#ifdef BUSYTEX_PDFTEX
extern int busymain_pdftex(int argc, char* argv[]);
#endif
#ifdef BUSYTEX_XETEX
extern int busymain_xetex(int argc, char* argv[]);
#endif
#ifdef BUSYTEX_XDVIPDFMX
extern int busymain_xdvipdfmx(int argc, char* argv[]);
#endif
#ifdef BUSYTEX_BIBTEX8
extern int busymain_bibtex8(int argc, char* argv[]);
#endif
#ifdef BUSYTEX_MAKEINDEX
extern int busymain_makeindex(int argc, char* argv[]);
#endif
#ifdef BUSYTEX_KPSE
extern int busymain_kpsewhich(int argc, char* argv[]);
extern int busymain_kpsestat(int argc, char* argv[]);
extern int busymain_kpseaccess(int argc, char* argv[]);
extern int busymain_kpsereadlink(int argc, char* argv[]);
#endif

void flush_streams()
{
    fputc('\n', stdout);
    fputc('\n', stderr);
    fflush(NULL);
}

void setenvjoin(const char* name, const char* value)
{
    enum {setenvjoinsize = 65536, joinsep = ':'};
    char tmp[setenvjoinsize];
    const char* cur = getenv(name);
    snprintf(tmp, setenvjoinsize, (cur == NULL || cur[0] == '\0') ? "%s" : "%s%c%s", value, joinsep, cur);
    setenv(name, tmp, 1);
}

int main(int argc, char* argv[])
{
    /*fprintf(stderr, "BEGINBUSYTEX\n");
    for(int i = 0; i < argc; i++)
        fprintf(stderr, "%s ", argv[i]);
    fprintf(stderr, "\n");
    extern char **environ;
    for(int i = 0; environ[i] != NULL; i++)
        fprintf(stderr, "%s\n", environ[i]);
    fprintf(stderr, "\nENDBUSYTEX\n");*/

    struct stat statbuf;
    if(getenv("TEXMFDIST") == NULL && stat("/texlive/texmf-dist", &statbuf) == 0)
    {
        setenvjoin("TEXMFDIST", "/texlive/texmf-dist");
        setenvjoin("TEXMFVAR",  "/texlive/texmf-dist/texmf-var");
        setenvjoin("TEXMFCNF",  "/texlive/texmf-dist/web2c");
        setenvjoin("FONTCONFIG_PATH", "/texlive/");
        //putenv("PDFLATEXFMT=/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex.fmt");
    }

    if(argc < 2)
    {
        printf("\n"
#ifdef BUSYTEX_PDFTEX
            "pdftex\n"
#endif
#ifdef BUSYTEX_XETEX
            "xetex\n"
#endif
#ifdef BUSYTEX_XDVIPDFMX
            "xdvipdfmx\n"
#endif
#ifdef BUSYTEX_BIBTEX8
            "bibtex8\n"
#endif
#ifdef BUSYTEX_MAKEINDEX
            "makeindex\n"
#endif
#ifdef BUSYTEX_KPSE
            "kpsewhich\n"
            "kpsestat\n"
            "kpseaccess\n"
            "kpsereadlink\n"
#endif
        );
        return 0;
    }

    extern int optind;
#ifdef BUSYTEX_PDFTEX
    if(0 == strcmp("pdftex", argv[1]) || 0 == strcmp("pdflatex", argv[1]))     { argv[1] = argv[0]; optind = 1; return busymain_pdftex  (argc - 1, argv + 1); }
#endif
#ifdef BUSYTEX_XETEX
    if(0 == strcmp("xetex", argv[1]) || 0 == strcmp("xelatex", argv[1]))       { argv[1] = argv[0]; optind = 1; return busymain_xetex   (argc - 1, argv + 1); }
#endif
#ifdef BUSYTEX_XDVIPDFMX
    if(0 == strcmp("xdvipdfmx", argv[1]))    { argv[1] = argv[0]; optind = 1; return busymain_xdvipdfmx   (argc - 1, argv + 1); }
#endif
#ifdef BUSYTEX_BIBTEX8
    if(0 == strcmp("bibtex8", argv[1]))      { argv[1] = argv[0]; optind = 1; return busymain_bibtex8     (argc - 1, argv + 1); }
#endif
#ifdef BUSYTEX_MAKEINDEX
    if(0 == strcmp("makeindex", argv[1]))    { argv[1] = argv[0]; optind = 1; return busymain_makeindex   (argc - 1, argv + 1); }
#endif
#ifdef BUSYTEX_KPSE
    if(0 == strcmp("kpsewhich", argv[1]))    { argv[1] = argv[0]; optind = 1; return busymain_kpsewhich   (argc - 1, argv + 1); }
    if(0 == strcmp("kpsestat", argv[1]))     { argv[1] = argv[0]; optind = 1; return busymain_kpsestat    (argc - 1, argv + 1); }
    if(0 == strcmp("kpseaccess", argv[1]))   { argv[1] = argv[0]; optind = 1; return busymain_kpseaccess  (argc - 1, argv + 1); }
    if(0 == strcmp("kpsereadlink", argv[1])) { argv[1] = argv[0]; optind = 1; return busymain_kpsereadlink(argc - 1, argv + 1); }
#endif
    return 1;
}
