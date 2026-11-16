# Adds the "Kit Graphite" color scheme and a "Claude Kit" profile to Windows Terminal.
# Backs the settings file up first; leaves every existing profile and the default as they are.
# Usage: python add-to-windows-terminal.py [path to terminal-backdrop.png]   (default: the image beside this script)
import json, os, re, shutil, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))

# Windows Terminal keeps its settings in one of these, by how it was installed (Store, Preview, Canary, unpackaged).
CANDIDATES = [
    r'%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json',
    r'%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe\LocalState\settings.json',
    r'%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminalCanary_8wekyb3d8bbwe\LocalState\settings.json',
    r'%LOCALAPPDATA%\Microsoft\Windows Terminal\settings.json',
]


def stop(message):
    print(message)
    sys.exit(1)


def strip_comments(text):
    """Windows Terminal allows // and /* */ comments and trailing commas; plain json does not."""
    out, i, n, in_str = [], 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == '\\' and i + 1 < n:
                out.append(text[i + 1])
                i += 1
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
            out.append(c)
        elif text.startswith('//', i):
            while i < n and text[i] != '\n':
                i += 1
            continue
        elif text.startswith('/*', i):
            end = text.find('*/', i + 2)
            i = n if end < 0 else end + 2
            continue
        else:
            out.append(c)
        i += 1
    return re.sub(r',(\s*[}\]])', r'\1', ''.join(out))


if os.name != 'nt':
    stop('This script is for Windows Terminal on Windows; nothing was changed.')

found = [p for p in (os.path.expandvars(c) for c in CANDIDATES) if os.path.isfile(p)]
if not found:
    stop('Windows Terminal settings were not found. Open Windows Terminal once, then run this again; nothing was changed.')

image = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, 'terminal-backdrop.png')
if not os.path.isfile(image):
    stop(f'The backdrop image was not found: {image}; nothing was changed.')

scheme = {
    'name': 'Kit Graphite',
    'background': '#141414',
    'foreground': '#F0EFEC',
    'cursorColor': '#EFEFEF',
    'selectionBackground': '#3A3A3A',
    'black': '#1B1B1B',
    'red': '#C0453A',
    'green': '#4F8A5B',
    'yellow': '#B8862B',
    'blue': '#6E8FB0',
    'purple': '#7A68A6',
    'cyan': '#5F9EA0',
    'white': '#C6C5C1',
    'brightBlack': '#5A5A5A',
    'brightRed': '#D9695E',
    'brightGreen': '#6FAE7B',
    'brightYellow': '#D6A64D',
    'brightBlue': '#8FB0CF',
    'brightPurple': '#9C8CC6',
    'brightCyan': '#7FBFC1',
    'brightWhite': '#F0EFEC',
}

# PowerShell 7 when it is installed, else the Windows PowerShell every Windows has.
shell = 'pwsh.exe -NoLogo' if shutil.which('pwsh') else 'powershell.exe -NoLogo'

for settings in found:
    try:
        with open(settings, encoding='utf-8-sig') as f:
            data = json.loads(strip_comments(f.read()))
    except (OSError, ValueError) as err:
        print(f'Skipped {settings}: it could not be read ({err}); nothing was changed there.')
        continue

    backup = settings + '.bak-' + time.strftime('%Y%m%d-%H%M%S')
    shutil.copy2(settings, backup)

    data['schemes'] = [s for s in data.get('schemes', []) if s.get('name') != scheme['name']] + [scheme]

    profile = {
        'guid': '{6b1f3c2a-9d4e-4f7a-8c21-5e0a7d9b4c13}',
        'name': 'Claude Kit',
        'commandline': shell,
        'startingDirectory': '%USERPROFILE%',
        'colorScheme': 'Kit Graphite',
        'backgroundImage': image,
        'backgroundImageOpacity': 0.35,
        'backgroundImageStretchMode': 'uniformToFill',
        'backgroundImageAlignment': 'center',
        'hidden': False,
    }
    profiles = data.get('profiles')
    if isinstance(profiles, list):  # the older shape: profiles is the list itself
        data['profiles'] = profiles = {'list': profiles}
    profiles = data.setdefault('profiles', {})
    items = profiles.setdefault('list', [])
    items[:] = [p for p in items if p.get('guid') != profile['guid']] + [profile]

    with open(settings, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=4, ensure_ascii=False)
        f.write('\n')

    print(f'Added the "Claude Kit" profile and the "Kit Graphite" scheme to {settings}')
    print(f'Backup: {backup}. Your default profile is unchanged.')
