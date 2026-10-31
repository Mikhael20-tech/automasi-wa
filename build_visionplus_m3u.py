import re

category_map = {
    # Nasional / FTA
    'RCTI': 'Nasional',
    'MNCTV': 'Nasional',
    'GTV': 'Nasional',
    'iNews': 'Nasional',
    'SindoNews': 'Nasional',
    'Trans TV': 'Nasional',
    'Trans 7': 'Nasional',
    'SCTV': 'Nasional',
    'Indosiar': 'Nasional',
    'ANTV': 'Nasional',
    'RTV': 'Nasional',
    'TVOne': 'Nasional',
    'Kompas TV': 'Nasional',
    'Metro TV': 'Nasional',
    'BTV': 'Nasional',
    'TVRI': 'Nasional',
    'DAAI TV': 'Nasional',
    'Moji': 'Nasional',
    'Mentari TV': 'Nasional',
    'MDTV': 'Nasional',

    # Daerah & Budaya
    'JTV': 'Daerah & Budaya',
    'JAK TV': 'Daerah & Budaya',
    'Bali TV': 'Daerah & Budaya',
    'Bandung TV': 'Daerah & Budaya',
    'TV 9': 'Daerah & Budaya',
    'Hanacaraka TV': 'Daerah & Budaya',

    # Religi
    'DMI TV': 'Religi',
    'TV MU': 'Religi',
    'Muslim TV': 'Religi',
    'LIFE': 'Religi',
    'Reformed 21': 'Religi',
    'Al Quran Al Kareem': 'Religi',
    'EWTN': 'Religi',

    # Movies
    'Originals': 'Movies',
    'Buddy Star': 'Movies',
    'Uniques': 'Movies',
    'Superrix': 'Movies',
    'Cineedge': 'Movies',
    'Thrill': 'Movies',
    'Hits Movies': 'Movies',
    'Celestial Movies': 'Movies',
    'CCM': 'Movies',
    'TVN Movies': 'Movies',
    'Zee Bioskop': 'Movies',
    'GALAXY PREMIUM': 'Movies',
    'GALAXY': 'Movies',
    'IMC': 'Movies',
    'Studio Universal': 'Movies',

    # Kids
    'Kids TV': 'Kids',
    'Moonbug': 'Kids',
    'Cbeebies': 'Kids',
    'Nick Jr': 'Kids',
    'Zoo Moo': 'Kids',
    'Nick': 'Kids',
    'Animax': 'Kids & Anime',
    'Dream Works': 'Kids',

    # Entertainment
    'HITS Now': 'Entertainment',
    'Formosa': 'Entertainment',
    'Sanlih': 'Entertainment',
    'Food Travel': 'Entertainment',
    'Entertainment': 'Entertainment',
    'TVN': 'Entertainment',
    'Kix': 'Entertainment',
    'Hits': 'Entertainment',
    'AXN': 'Entertainment',
    'Lifetime': 'Entertainment',
    'Vision Prime': 'Entertainment',
    'Celebrities TV': 'Entertainment',
    'Rock Entertainment': 'Entertainment',
    'Rock Action': 'Entertainment',
    'Drama World': 'Entertainment',
    'RCTI World': 'Entertainment',
    'GTV World': 'Entertainment',
    'MNCTV World': 'Entertainment',

    # Documentary & Music
    'Crime Investigation': 'Documentary',
    'Outdoor Channel': 'Documentary',
    'BBC Earth': 'Documentary',
    'Global Trekker': 'Documentary',
    'History': 'Documentary',
    'Love Nature': 'Documentary',
    'CGTN Documentary': 'Documentary',
    'Music TV': 'Music',

    # Sports
    'Sportstars 3': 'Sports',
    'Soccer Channel': 'Sports',
    'SpoTV 1': 'Sports',
    'SpoTV 2': 'Sports',
    'Fight Sports': 'Sports',
    'beIN SPORTS': 'Sports',
    'beIN SPORTS 2': 'Sports',
    'beIN SPORTS 3': 'Sports',

    # News
    'BBC World news': 'News',
    'CNBC Asia': 'News',
    'FOX News': 'News',
    'Bloomberg': 'News',
    'IDX': 'News',

    # Internasional
    'DW': 'Internasional',
    'France 24': 'Internasional',
    'TRT World': 'Internasional',
    'Aljazeera': 'Internasional',
    'RT': 'Internasional',
    'EURONEWS': 'Internasional',
    'Channel News Asia': 'Internasional',
    'CGTN': 'Internasional',
    'Anhui': 'Internasional',
    'Shanghai Dragon': 'Internasional',
    'Hunan TV': 'Internasional',
    'Jiangsu TV': 'Internasional',
    'NHK': 'Internasional',
    'NHK World Premium': 'Internasional',
    'TV5Monde': 'Internasional',
    'Arirang': 'Internasional',
    'ABC': 'Internasional'
}

def main():
    with open('d:/TOPIK 2/visionplus_raw.m3u', 'r', encoding='utf-8') as f:
        content = f.read()

    lines = content.splitlines()
    output = []
    category_counts = {}

    for line in lines:
        if line.startswith('#EXTINF:'):
            name = line.split(',')[-1].strip()
            group = category_map.get(name, 'Lainnya')
            category_counts[group] = category_counts.get(group, 0) + 1
            new_line = re.sub(r'group-title="[^"]*"', f'group-title="{group}"', line)
            output.append(new_line)
        else:
            output.append(line)

    result_text = '\n'.join(output) + '\n'
    target_file = 'd:/TOPIK 2/visionplus.m3u'
    with open(target_file, 'w', encoding='utf-8') as f:
        f.write(result_text)

    print(f"Berhasil membuat: {target_file}")
    print("Statistik Kategori Channel:")
    for cat, count in sorted(category_counts.items(), key=lambda x: -x[1]):
        print(f" - {cat}: {count} channel")

if __name__ == '__main__':
    main()
