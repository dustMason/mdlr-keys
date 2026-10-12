import {writeFileSync} from 'node:fs';
writeFileSync(new URL('../App/WebPanel/index.html',import.meta.url),`<!doctype html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>mdlr original panels</title><link rel="stylesheet" href="panel.css"><script defer src="panel.js"></script></head>
<body><div id="root"></div></body></html>`);
