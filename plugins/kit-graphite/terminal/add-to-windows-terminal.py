# Adds the "Kit Graphite" color scheme and a "Claude Kit" profile to Windows Terminal.
# Backs the settings file up first; leaves every existing profile and the default as they are.
import json, os, shutil, sys, time

settings = os.path.expandvars(r'%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json')
image = sys.argv[1]

backup = settings + '.bak-' + time.strftime('%Y%m%d-%H%M%S')
shutil.copy2(settings, backup)

with open(settings, encoding='utf-8') as f:
    data = json.load(f)

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
schemes = [s for s in data.get('schemes', []) if s.get('name') != scheme['name']]
schemes.append(scheme)
data['schemes'] = schemes

profile = {
    'guid': '{6b1f3c2a-9d4e-4f7a-8c21-5e0a7d9b4c13}',
    'name': 'Claude Kit',
    'commandline': 'pwsh.exe -NoLogo',
    'startingDirectory': 'D:\\Kit\\Work',
    'colorScheme': 'Kit Graphite',
    'backgroundImage': image,
    'backgroundImageOpacity': 0.35,
    'backgroundImageStretchMode': 'uniformToFill',
    'backgroundImageAlignment': 'center',
    'hidden': False,
}
profiles = data.setdefault('profiles', {})
items = profiles.setdefault('list', [])
items[:] = [p for p in items if p.get('guid') != profile['guid']]
items.append(profile)

with open(settings, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=4, ensure_ascii=False)
    f.write('\n')

print('backup', backup)
print('profiles', [p.get('name') for p in items])
print('schemes', [s.get('name') for s in data['schemes']])
print('default unchanged', data.get('defaultProfile'))
