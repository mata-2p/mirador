<img src="public/icon.svg" width="64" height="64" alt="Logo de Mirador: una ventana dividida en dos paneles, con un prompt de terminal en el izquierdo">

# Mirador

Mirador es un dashboard web local que sigue a los agentes de programación que corren en tu máquina, carpeta por carpeta, para que puedas tener varios a la vez sin perderle el hilo a ninguno.

- **Dónde quedó:** cada proyecto muestra dónde se detuvo su última sesión.
- **Control de recursos:** un scope de systemd por agente, una compuerta de arranque según la memoria y agentes inactivos que se duermen (Linux).
- **Se queda en la máquina:** sin telemetría, sin cuentas, el servidor escucha solo en 127.0.0.1.

[![test](https://github.com/mata-2p/mirador/actions/workflows/test.yml/badge.svg)](https://github.com/mata-2p/mirador/actions/workflows/test.yml) [![GitHub Sponsors](https://img.shields.io/github/sponsors/mata-2p)](https://github.com/sponsors/mata-2p) [![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/matiasjbarriah) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

[English](README.md) · Español

[Por qué Mirador](#por-qué-mirador) · [Inicio rápido](#inicio-rápido) · [Qué hace](#qué-hace) · [Cómo se compara Mirador](#cómo-se-compara-mirador) · [Cómo funciona](#cómo-funciona) · [Configuración](#configuración) · [Desarrollo](#desarrollo) · [Guía de instalación](docs/install.md)

![Un recorrido corto por Mirador en un workspace de demostración inventado, con los proyectos acme-api, acme-web y field-notes](docs/img/demo.gif)

## Por qué Mirador

En qué se enfoca Mirador:

- **Dónde quedó.** Cada proyecto muestra dónde se detuvo su última sesión, desde Engram o los últimos mensajes de Claude Code ([detalles](docs/attention.md#where-it-left-off)); una [vista de seguimiento](docs/attention.md#tracking-view) acompaña el día.
- **Control de recursos.** [Un scope de systemd por agente](docs/agents.md#one-systemd-scope-per-terminal) (Linux), una [compuerta de arranque](docs/agents.md#opening-many-agents-without-filling-the-memory) que espera memoria libre, [agentes inactivos que se duermen](docs/agents.md#sleeping-agents-lazy-restore) y [servidores MCP por proyecto](docs/agents.md#mcp-servers-per-project).
- **De vuelta tras un reinicio.** Los agentes [vuelven](docs/agents.md#reopening-agents-after-a-restart) a su carpeta y, con gentle-shell, pi, Claude Code, opencode o Antigravity, a su sesión.
- **Mirador mismo se queda en la máquina.** Cero telemetría, sin cuentas, y el servidor escucha solo en `127.0.0.1` ([qué sale de la máquina y qué guarda](docs/security.md#what-stays-on-the-machine), en inglés).
- **Una ventana del navegador.** No necesita GPU, Vulkan ni sesión de escritorio, y dentro de WSL2 se abre en el navegador de Windows ([detalles](docs/configuration.md#browser)).
- **Integración nativa con gentle-shell, pi y Engram**, y cualquier agente de terminal o un `bash` simple también funcionan ([modos](docs/install.md#modes)).

La vista de seguimiento, y después la bandeja de atención y el panel **Dónde quedó** de una carpeta, en el workspace de demostración; cada una se abre a tamaño completo:

<p><a href="docs/img/tracking.png"><img src="docs/img/tracking.png" alt="La vista de seguimiento en el workspace de demostración, con los agentes en carriles según lo que necesitan de ti"></a></p>

<p><a href="docs/img/inbox.png"><img src="docs/img/inbox.png" width="600" alt="La lista Te esperan de la bandeja de atención en el workspace de demostración"></a> <a href="docs/img/left-off.png"><img src="docs/img/left-off.png" width="240" alt="El panel Dónde quedó de una carpeta de demostración: su último día trabajado y los próximos pasos de su última sesión"></a></p>

Mirador es un proyecto independiente, no una parte oficial de gentle-shell; se apoya en [gentle-shell](https://github.com/Gentleman-Programming/gentle-shell), pi y Engram, y agradece a esa comunidad.

## Inicio rápido

Este camino no necesita gentle-shell ni Engram: cada carpeta abre un `bash` simple, y los extras de Gentle quedan ocultos.

En Linux x64 y arm64 con glibc 2.28 o más reciente, una línea instala el release precompilado, sin nada que compilar; en otros sistemas instala desde el código fuente. Lee [el script](scripts/bootstrap.sh) antes de correrlo:

```sh
curl -fsSL https://raw.githubusercontent.com/mata-2p/mirador/main/scripts/bootstrap.sh | sh
```

**Arrancarlo.** Después de la instalación en una línea del release precompilado, `bin/mirador` es `~/.local/share/mirador/current/bin/mirador`; después de la instalación en una línea desde el código fuente es `~/.local/share/mirador/bin/mirador`. En Linux el instalador también enlaza `~/.local/bin/mirador`, así que `mirador` funciona desde cualquier carpeta una vez que `~/.local/bin` está en el `PATH` (el instalador avisa cuando no lo está). `bin/mirador stop` lo detiene.

**La carpeta del workspace.** Mirador muestra las carpetas dentro del `root` de cada workspace. En el primer arranque, sin archivo de configuración todavía, muestra un workspace, Dev, sobre `~/Dev`, o sobre tu carpeta personal cuando `~/Dev` no existe. Para agregar otro, haz clic en **Agregar** junto a **Workspaces** en la barra lateral; en **Agregar un workspace**, escribe la **Carpeta** (la ruta completa de una carpeta que exista; `~` es tu carpeta personal) y, si quieres, un **Nombre (opcional)**, y haz clic en **Agregar workspace**. Mirador escribe los workspaces en `~/.config/mirador/config.json` la primera vez que cambias uno desde la app. La instalación desde el código fuente escribe ese archivo al instalar: [The workspace folder](docs/install.md#the-workspace-folder) (en inglés).

**Idioma.** La interfaz sigue el idioma del navegador (español para `es-*`, inglés en otro caso) hasta que eliges uno en **Ajustes** (el botón de los controles deslizantes, arriba a la derecha) → **Idioma**, con **EN** o **ES**.

Todo lo demás, desde los requisitos y la instalación desde el código fuente hasta macOS, WSL2, los pasos manuales, los modos y el informe del doctor, está en [docs/install.md](docs/install.md) (en inglés).

## Qué hace

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/overview-dark.png">
  <img src="docs/img/overview.png" alt="Mirador en un workspace de demostración inventado: el árbol de carpetas a la izquierda, tres terminales de agentes al centro y el panel lateral a la derecha mostrando dónde quedó el proyecto">
</picture>

Un panel local para las carpetas de tus proyectos, con terminales de agentes adentro. Cada fila enlaza a la descripción completa en `docs/` (en inglés).

| Capacidad | En una frase |
|-----------|--------------|
| [Dónde quedó](docs/attention.md#where-it-left-off) | **Dónde quedó** muestra el último día trabajado de cada carpeta y los próximos pasos del resumen de su última sesión, leídos de Engram, o el último mensaje de Claude Code y el tuyo cuando es más reciente, guardados localmente por 30 días (`leftOffDays`). |
| [Vista de seguimiento](docs/attention.md#tracking-view) | **Seguimiento** cambia el diseño por una vista general de solo lectura de los agentes en carriles según lo que necesitan de ti. |
| [Bandeja de atención](docs/attention.md#attention-inbox) | **Te esperan (N)** lista las terminales de agentes que necesitan tu respuesta o terminaron su turno. |
| [Un scope de systemd por terminal](docs/agents.md#one-systemd-scope-per-terminal) | En Linux cada terminal corre en su propio scope de usuario de systemd, así que una muerte por falta de memoria se lleva una terminal, no todas. |
| [Compuerta de arranque según la memoria](docs/agents.md#opening-many-agents-without-filling-the-memory) | Los agentes abiertos seguidos arrancan en tandas y esperan mientras la memoria libre está bajo la reserva. |
| [Agentes dormidos](docs/agents.md#sleeping-agents-lazy-restore) | Después de un reinicio, los agentes que habían terminado su turno duermen sin proceso hasta que los despiertas. |
| [Reabrir tras un reinicio](docs/agents.md#reopening-agents-after-a-restart) | Los agentes abiertos vuelven en el siguiente arranque, en su carpeta y, con gentle-shell, pi, Claude Code, opencode o Antigravity, en su sesión. |
| [Abrir varios agentes](docs/agents.md#opening-several-agents) | Marca carpetas en el modo de selección, o guárdalas como los proyectos del workspace, y abre un agente en cada una. |
| [Servidores MCP por proyecto](docs/agents.md#mcp-servers-per-project) | Apaga los servidores MCP que una carpeta no necesita, lo que ahorra memoria en cada agente que se abre ahí. |
| [Ventana del navegador](docs/configuration.md#browser) | Un navegador de la familia Chromium abre Mirador como ventana de aplicación; cualquier otro navegador recibe una pestaña, y la clave `browser` cambia la elección. |
| [Cambios](docs/features.md#what-it-does) | **Cambios** muestra los cambios de una carpeta o de un workspace respecto de su último commit, preparados y sin preparar juntos, con el diff de cada archivo coloreado por línea; solo lee el repositorio. |
| [Avisos del navegador](docs/attention.md#attention-inbox) | Apagados hasta que haces clic en **Activar avisos del navegador** en la bandeja; desde entonces, un agente que empieza a esperarte o se detiene con un error muestra un aviso del navegador, con el ícono de Mirador, el proyecto y el motivo como título y la pregunta, el agente y la ruta en el cuerpo (puede llegar hasta 1,5 s después de la tarjeta, y 3 o más en 1,5 s comparten un aviso; un modo discreto oculta los detalles), y los turnos terminados nunca avisan. |
| [Turno de noche](docs/attention.md#tracking-view) | En el modo completo, el **Piloto automático** responde las preguntas de los agentes mientras no estás, según un horario o encendido a mano, te deja las acciones sensibles y registra cada paso en la vista de seguimiento. |
| [Editor de archivos](docs/features.md#file-editor) | **Archivos** edita los archivos de texto de una carpeta, primero los archivos dotenv, y pregunta antes de sobrescribir el cambio de un agente. |
| [Seguridad](docs/security.md#security) | El servidor escucha solo en `127.0.0.1` y revisa un token de sesión, el encabezado `Host` y, en cada cambio, el `Origin` propio de la aplicación. |

Para abrir Mirador desde otra máquina, reenvía su puerto con `ssh -L` después de leer los riesgos: [Opening Mirador from another machine](docs/security.md#opening-mirador-from-another-machine).

Los workspaces, el árbol de carpetas, las terminales como pestañas o en grilla, el resumen diario, los ajustes del turno de noche y los perfiles de recursos están en [docs/features.md](docs/features.md). Para contribuir: [CONTRIBUTING.md](CONTRIBUTING.md); para reportar una vulnerabilidad: [SECURITY.md](SECURITY.md).

## Cómo se compara Mirador

Otras herramientas también corren agentes de programación lado a lado.

| Quieres… | Mira |
|---|---|
| Dónde quedó cada agente local | Mirador |
| Un scope de systemd por agente, una compuerta de arranque según la memoria y agentes inactivos que se duermen (Linux) | Mirador |
| Agentes de vuelta en su carpeta y su sesión tras un reinicio | Mirador |
| Una ventana del navegador sin GPU, Vulkan ni sesión de escritorio, también dentro de WSL2 | Mirador |
| Integración nativa con gentle-shell, pi y Engram | Mirador |
| Máquinas remotas por SSH | Herdr, cmux (`cmux ssh`), Emdash (SSH/SFTP), Claude Code Desktop |
| Una app para el teléfono | Herdr (iPhone, iPad, Android), Paradev (Apple, Android), Claude Code Desktop (app móvil de Claude), cmux (iPhone beta) |
| Agentes en worktrees de git | Paradev, Emdash, Claude Code Desktop (por sesión, apagados por defecto) |
| Una app de escritorio en macOS | Herdr (Apple silicon), Paradev, Claude Code Desktop, cmux (app de terminal), Emdash |
| Una app de escritorio en Linux | Paradev, Claude Code Desktop (beta), Emdash |
| Una app de escritorio en Windows | Claude Code Desktop, Emdash |
| Una interfaz de terminal en un solo binario de Rust para macOS, Linux y Windows | Herdr TUI |

Si necesitas máquinas remotas por SSH, una app para el teléfono o un solo binario de Rust (Herdr TUI, junto a su app de escritorio nativa), [Herdr](https://herdr.dev) (Apache-2.0) hace eso hoy y Mirador no. Mirador no tiene relación con Herdr: los nombres `herdr` en su código son una capa de compatibilidad con gentle-shell ([`bin/herdr-shim`](CONTRIBUTING.md#gentle-names-in-the-code)), y Mirador no incluye ni corre Herdr.

<details>
<summary>Lo que decía el sitio o repositorio de cada herramienta el 2026-11-26</summary>

La tabla muestra lo que decía el sitio o repositorio propio de cada una el 2026-11-26. Una raya significa que sus páginas oficiales no lo dicen, y "No" significa que dicen que no; el sitio de cada proyecto es la fuente de verdad y las cosas cambian.

| | **Mirador** | [Herdr](https://herdr.dev) | [Paradev](https://paradev.com) | [Claude Code Desktop](https://code.claude.com/docs/en/desktop) | [cmux](https://github.com/manaflow-ai/cmux) | [Emdash](https://github.com/generalaction/emdash) (Classic) |
|---|---|---|---|---|---|---|
| Forma | Panel web¹ | App de escritorio, TUI² | App de escritorio³ | App de escritorio⁴ | App de terminal⁵ | App de escritorio |
| Plataformas | Linux, WSL2, macOS¹ | macOS², Linux, Windows | macOS, Linux³ | macOS, Windows, Linux beta⁴ | Solo macOS⁵ | macOS, Windows, Linux |
| Licencia | Apache-2.0 | Apache-2.0 | MIT | — | GPL-3.0-or-later⁵ | Apache-2.0 |
| Agentes en worktrees de git | No | — | Sí | Opcional⁴ | — | Sí |
| Máquinas remotas y teléfono | [Túnel `ssh -L`](docs/security.md#opening-mirador-from-another-machine)¹ | SSH, apps móviles² | Teléfono, nube³ | SSH, nube, teléfono⁴ | SSH, iPhone beta⁵ | SSH/SFTP |

¹ Mirador: un panel web local en una ventana del navegador; macOS es experimental; sin app, pero la bandeja se puede usar en el navegador del teléfono a través del mismo túnel ([experimental](docs/attention.md#the-phone-inbox-is-experimental)).<br>
² Herdr: una app de escritorio nativa más Herdr TUI en la terminal, un solo binario de Rust para macOS, Linux y Windows; macOS en Apple silicon; apps para iPhone, iPad y Android.<br>
³ Paradev: también una CLI, un SDK y un servidor MCP; "Windows is not yet available" (Windows aún no está disponible); la app para el teléfono es para dispositivos Apple y Android.<br>
⁴ Claude Code Desktop: la pestaña Code de la app de escritorio de Claude; Linux beta para Ubuntu y Debian; worktrees por sesión, apagados por defecto; sesiones en la nube en claude.ai/code o en la app móvil de Claude, y una sesión local aparece en tus otros dispositivos con Remote Control en las apps de Claude.<br>
⁵ cmux: una app de terminal nativa de macOS, solo macOS por ahora; partes del servidor bajo BUSL-1.1; SSH con `cmux ssh`; la app para iPhone está en beta en TestFlight.

</details>

## Cómo funciona

Un servidor local, que arranca `mirador`, corre cada terminal con node-pty y sirve la interfaz a una ventana del navegador en la misma máquina. Los agentes avisan cuando te esperan, y Engram, cuando corre, aporta la memoria detrás de los resúmenes y de **Dónde quedó**. Los módulos y el flujo de datos están en [docs/how-it-works.md](docs/how-it-works.md).

```mermaid
flowchart LR
  W["Ventana del navegador<br/>ventana de aplicación o pestaña"] -- "HTTP y WebSocket<br/>token de sesión, revisión de Host y Origin" --> S["Servidor local<br/>127.0.0.1:4545"]
  S --> T["terminales node-pty<br/>un scope de systemd cada una (Linux)"]
  T --> A["Agentes<br/>gentle-shell, pi o cualquier CLI"]
  T --> B["bash simple"]
  A -- "avisos de atención" --> S
  A -- "guardan memorias" --> E[("Engram<br/>127.0.0.1:7437")]
  S -- "resúmenes y dónde quedó" --> E
```

La vida de un agente a través de los reinicios ([detalles](docs/agents.md#reopening-agents-after-a-restart)):

```mermaid
flowchart LR
  L["Lanzado<br/>solo, o en una tanda por la compuerta de arranque"] --> R["Corriendo<br/>trabajando o esperándote"]
  R -- "termina el turno" --> F["Terminó su turno"]
  F -- "vuelve a empezar" --> R
  R --> X{"Mirador se detiene, se cae<br/>o la máquina se reinicia"}
  F --> X
  X -- "estaba trabajando, esperando o desconocido" --> O["Reabierto en el siguiente arranque<br/>por la compuerta de arranque"]
  X -- "había terminado su turno" --> Z["Dormido<br/>sin proceso, registro guardado"]
  Z -- "Despertar" --> O
  O -- "gentle-shell, pi, Claude Code,<br/>opencode, Antigravity" --> P["De vuelta en su sesión"]
  O -- "otros agentes" --> D["De vuelta en su carpeta"]
```

## Límites conocidos

- Sin scopes de systemd, `mirador stop` puede dejar vivos procesos que un agente arrancó en segundo plano ([#1](https://github.com/mata-2p/mirador/issues/1)). Los scopes están apagados con `MIRADOR_SCOPES=0`, con `scopes: false` en la configuración, en macOS, y en Linux o WSL2 donde `systemd-run --user --scope` no funciona.
- Una vez que viste la tarjeta de terminado o de error de un agente, la barra lateral, su pestaña y su panel lo muestran trabajando; Seguimiento sigue mostrando su estado real ([#12](https://github.com/mata-2p/mirador/issues/12)).

## Configuración

`~/.config/mirador/config.json`. Los cambios de workspace desde la interfaz escriben solo `workspaces`; todas las claves son opcionales:

```json
{
  "workspaces": [
    { "id": "dev", "name": "Dev", "root": "/home/you/Dev", "folders": ["tools", "web"], "expanded": ["web"] }
  ],
  "port": 4545,
  "engramUrl": "http://127.0.0.1:7437",
  "agentCommand": "gentle-shell",
  "ignore": ["node_modules", "bin", "obj", "dist", "build", "target", "coverage", "__pycache__"],
  "timeZone": "America/Santiago"
}
```

Qué hace cada clave, la elección manual de `browser`, los comandos (`mirador link | status | stop | logs`) y una configuración rota: [docs/configuration.md](docs/configuration.md). Los ajustes `launches` de la compuerta de arranque: [docs/agents.md](docs/agents.md#opening-many-agents-without-filling-the-memory).

Las terminales corren en scopes de systemd donde `systemd-run --user --scope` funciona. `MIRADOR_SCOPES=0` en el entorno, o `"scopes": false` en la configuración, los apaga: [One systemd scope per terminal](docs/agents.md#one-systemd-scope-per-terminal).

## Desarrollo

```sh
pnpm test                 # node --test 'test/**/*.test.ts'
```

Las funciones nuevas se conectan como un módulo de rutas y un módulo de interfaz cada una; [docs/extending.md](docs/extending.md) lista los helpers compartidos, los eventos, los espacios del DOM y las líneas en que cada función se registra. [docs/releasing.md](docs/releasing.md) es para quienes mantienen el proyecto: sacar un release, revisar su borrador y el PR de promoción que lo fija en `scripts/bootstrap.sh`. Los nombres de las herramientas Gentle que aparecen en el código, la configuración y `doctor` (gentle-ai, Engram, gentle-deck, `bin/herdr-shim`) se explican en [Gentle names](CONTRIBUTING.md#gentle-names-in-the-code).

## Autor

Mirador fue creado por Matías Barría ([@mata-2p](https://github.com/mata-2p)), fundador de [ZURAI](https://zurai.cl).
¿Necesitas software a medida o consultoría? Escríbele a ZURAI en [zurai.cl](https://zurai.cl).

## Licencia

Mirador se publica bajo la [Apache License 2.0](LICENSE). Puedes usarlo, modificarlo y redistribuirlo, también con fines comerciales, siempre que conserves el aviso ([NOTICE](NOTICE)); quienes contribuyen otorgan una licencia de patentes sobre sus contribuciones.

## Patrocinio

Mirador es gratis y se financia con donaciones: los niveles mensuales están en GitHub Sponsors y las propinas únicas en Ko-fi, ambos descritos en [SPONSORS.md](SPONSORS.md). Nada en la app es de pago, y no hay telemetría.
