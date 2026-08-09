# 🧟 Zombie Simulator

Simulation d'épidémie zombie **sur une vraie carte satellite**. On délimite une zone
n'importe où dans le monde, l'application y importe le terrain réel depuis
OpenStreetMap (bâtiments, cours d'eau, routes, murs), y installe une population
cohérente avec le bâti, puis on regarde la situation dégénérer — en appelant des
hélicoptères d'évacuation, des frappes aériennes et des largages de munitions.

Application 100 % statique : **aucun build, aucune dépendance à installer**.
Elle fonctionne telle quelle sur GitHub Pages.

---

## Démarrage

### En local

```bash
python -m http.server 8123
```

Puis ouvrir <http://localhost:8123>. (Un serveur est nécessaire : le projet
utilise des modules ES, qui ne se chargent pas depuis `file://`.)

### Sur GitHub Pages

```bash
git init && git add . && git commit -m "Zombie Simulator"
git branch -M main
git remote add origin https://github.com/<utilisateur>/<depot>.git
git push -u origin main
```

Puis dans le dépôt : **Settings → Pages → Source : Deploy from a branch →
`main` / `(root)`**. Le site est en ligne une minute plus tard.

---

## Prise en main

1. **Chercher un lieu** dans la barre du haut (ville, adresse).
2. **Dessiner la zone** : bouton `✏️`, puis clic-glisser sur la carte.
   Maximum 4 km de côté (au-delà, la grille de navigation devient trop lourde).
3. **Charger le terrain (OSM)** : l'application interroge Overpass et rasterise
   bâtiments, eau, routes et barrières. Compter 5 à 30 s selon la charge du
   serveur Overpass.
4. Régler la population, les forces armées, les zombies.
5. **Lancer une vague** puis **▶** (ou `Espace`).

### Raccourcis

| Touche | Action |
|---|---|
| `Espace` | Lecture / pause |
| `Tab` | Afficher/masquer le panneau |
| `F` | Recadrer la vue sur la zone de jeu |
| `1` … `5` | Évac · Frappe · Largage · Patrouille · Placer zombies |
| `6` `7` `8` | Base · Barrage routier · Ratissage |
| `Échap` | Désélectionner l'outil |

---

## Ce que fait la simulation

### Terrain

Les données OSM sont rasterisées dans une **grille de 2 m** où chaque cellule
porte des drapeaux :

| Drapeau | Effet |
|---|---|
| `BUILDING` | bloque le déplacement **et** la vue |
| `WALL` | bloque le déplacement **et** la vue |
| `FENCE` | bloque le déplacement, laisse passer le regard |
| `WATER` | infranchissable à pied |
| `ROAD` | déplacement plus rapide, lieu d'apparition privilégié |
| `RUBBLE` | franchissable au ralenti (après une frappe) |

Les **composantes connexes** de la carte sont précalculées : aucune unité
n'apparaît dans une cour fermée, et un trajet vers une zone non reliée est
rejeté immédiatement au lieu de faire tourner l'A\* dans le vide.

### Population

Le nombre de civils est déduit du bâti : `emprise au sol × étages ÷ 110 m²`,
pondéré par l'usage du bâtiment (`apartments` ≫ `warehouse`, un `garage`
n'héberge personne). Le curseur de densité multiplie le tout.

Au départ, la plupart des habitants sont **à l'intérieur** (points jaunes sur les
bâtiments) : ils y sont en sécurité. Ils ne sortent que si un hélicoptère se pose
à portée, si les zombies **enfoncent la porte** (6 s de présence devant le
bâtiment), ou en panique extrême — sinon toute la ville se retrouverait dans la
rue à la première rafale.

### Comportements

- **Civils** — errent, fuient les zombies en criant (ce qui attire d'autres
  zombies), rejoignent l'hélicoptère, rentrent chez eux quand le calme revient.
  Une fraction d'entre eux est armée.
- **Gendarmes / militaires** — voir *Escouades* ci-dessous : ils opèrent en
  groupe, regroupent et escortent les civils, montent des barrages et se
  ravitaillent quand ils sont à sec.
- **Zombies** — vue en cône (portée réglable) bloquée par les bâtiments, ouïe
  (réglable) qui les oriente vers les coups de feu, les cris et les explosions.
  Sans proie, ils repèrent les bâtiments habités et forcent l'entrée.
  Lents ou rapides, en proportion réglable.

### Escouades

Les combattants ne décident plus individuellement. Ils sont répartis en
**escouades** (6 militaires, 3 gendarmes) : l'escouade porte la mission, le chef
mène, les équipiers tiennent une formation en V — ou un anneau autour des civils
quand ils escortent. Un soldat ne poursuit jamais un zombie au point de quitter
son groupe ou d'abandonner les gens qu'il protège.

Sans ordre du joueur, une escouade agit d'elle-même : elle **ramasse les civils
qu'elle croise**, les **escorte vers la base** — ou, à défaut, vers le secteur le
plus calme d'après la carte de menace — puis repart chercher du monde là où il en
reste. Elle avance au pas des civils, jamais plus vite.

| Ordre | Déclenchement |
|---|---|
| Escorte | par défaut, sans ordre |
| Patrouille | outil 🎯, rectangle tracé à la souris |
| Barrage | outil 🚧, sur une route |
| Ratissage | outil ⚔️, sur un secteur |
| Ralliement base | bouton « Tous à la base » |
| Ravitaillement | automatique sous 60 cartouches par homme |

### Munitions

Un militaire porte **300 cartouches** (30 en chargeur + 270 en réserve), un
gendarme 120. Chaque tir en consomme une, les rechargements prennent du temps.
Sous 60 cartouches par homme, l'escouade **rompt le contact** et rejoint la
source la plus proche — base, camion de ravitaillement ou caisse parachutée —
puis reprend sa mission là où elle l'avait laissée.

### Base

Placée par le joueur (outil 🏕️), elle rayonne sur 70 m et sert de
**ravitaillement, d'infirmerie et de refuge** : les soldats y refont le plein,
les blessés s'y soignent, et c'est la destination par défaut de toutes les
escortes. Le compteur 🟢 du bandeau indique les civils à l'abri.

### Barrages routiers

Un barrage se **construit** : l'escouade désignée s'y rend, met une vingtaine de
secondes à l'établir (plus vite à plusieurs), puis le tient. Une fois monté, il
coupe la route à tout véhicule et ralentit fortement les zombies, qui doivent
l'escalader.

### Véhicules

Voitures de particuliers, fourgons, camions de transport et camion de
ravitaillement. Ils **ne circulent que sur la voirie OSM** — pathfinding dédié
sur les composantes connexes du réseau routier — avec inertie, braquage limité,
freinage devant un obstacle, et écrasement des zombies happés par la calandre.

- Une **escouade** qui doit franchir plus de 220 m embarque, avec les civils
  qu'elle escorte.
- Des **civils paniqués** réquisitionnent une voiture, attendent une dizaine de
  secondes leurs voisins, puis filent vers la base — ou hors de la zone s'il n'y
  a pas de base, auquel cas ils comptent comme évacués.
- Une frappe transforme un véhicule en **épave**, qui obstrue durablement la
  chaussée.

### Maisons barricadées

Un civil enfermé et inquiet **barricade sa maison** : chaque niveau (3 au
maximum, arc bleu autour du halo) rallonge de 9 s le temps qu'un zombie met à
entrer. Une effraction réussie fait sauter un niveau.

S'il est **armé, il tire par la fenêtre** sur ce qui passe à moins de 34 m. La
ligne de vue part de la façade, pas du centre du bâtiment — sinon le bâtiment
bloquerait ses propres tirs.

### Infection

Une morsure blesse ; à zéro point de vie la victime tombe **au sol, contaminée**
(anneau de décompte autour du sprite) et se relève en zombie après le délai
réglé. Une victime achevée à l'explosif ne se relève pas.

### Opérations

| Outil | Effet |
|---|---|
| 🚁 **Évac** | Un hélicoptère arrive du bord le plus proche, se pose, embarque **un civil à la fois** (durée réglable), repart une fois plein ou le délai d'attente écoulé. Les civils s'y rendent par un *flow-field* partagé — un seul calcul pour toute la population. |
| 💥 **Frappe** | Compte à rebours puis explosion : dégâts dégressifs, bâtiments réduits en décombres (la carte devient franchissable à cet endroit), énorme signature sonore. |
| 📦 **Largage** | Caisse parachutée : armes pour les civils désarmés, munitions pour les militaires. 8 utilisations. |
| 🎯 **Patrouille** | Rectangle tracé à la souris : les 24 unités les plus proches y patrouillent. |
| 🧟 **Placer Z** | Lâcher un groupe de zombies au clic, pour tester une situation. |

---

## Architecture

```
index.html          interface
css/style.css
js/
  config.js         toutes les constantes de réglage (armes, unités, bruits…)
  geo.js            projection locale lat/lon ↔ mètres
  grid.js           grille de navigation, rasterisation, ligne de vue, composantes
  osm.js            requête Overpass, parsing, estimation de population
  pathfinding.js    A* (tas binaire, tampons réutilisés) + flow-fields Dijkstra
  spatial.js        hachage spatial pour la perception et la séparation
  entities.js       fabrique d'entités et fiches d'unités
  squads.js         commandement : formation, missions, escorte
  vehicles.js       conduite routière, embarquement, écrasement
  sim.js            boucle de simulation : IA, combat, infection, opérations
  render.js         rendu Canvas 2D par-dessus Leaflet
  main.js           carte, interface, boucle principale
test/               jeu de données OSM figé, pour tester sans réseau
```

**Boucle** : pas fixe à 20 Hz avec accumulateur, rendu découplé en
`requestAnimationFrame`. Le multiplicateur de vitesse (×1 à ×8) exécute
davantage de pas par image.

**Budget de pathfinding** : les demandes de chemin passent par une file
priorisée, au plus 28 A\* par tick. En attendant son chemin, une entité avance
« au flair » dans la direction dégagée la plus proche de son objectif — personne
ne reste jamais figé à attendre un calcul.

### Ordres de grandeur mesurés

Centre historique de Colmar, zone 536 × 401 m (445 bâtiments, 43 % de bâti) :

| | |
|---|---|
| Chargement Overpass | 2 à 7 s |
| Mise en place (rasterisation + composantes + peuplement) | 21 ms |
| ~1 600 entités, 8 escouades, 44 véhicules, un pas de simulation | 1,5 ms |
| Rendu d'une image (zone entière à l'écran) | 4,5 ms |
| Échecs de pathfinding | 0 % |

Une ville synthétique de 1,2 × 1,2 km avec 7 500 entités simultanées tourne à
8 ms par pas, soit encore du temps réel confortable en vitesse ×1.

---

### Taille des sprites

Un humain fait moins d'un mètre de large : à l'échelle métrique exacte il
occuperait **1 pixel** au zoom 17 — donc rien de visible. Les personnages sont
dessinés comme des **pions de carte**, avec une taille plancher en pixels, et ne
repassent à l'échelle réelle qu'au zoom 19-20. Le curseur *Taille des sprites*
(section 5) ajuste ce plancher de ×0,5 à ×3.

Les habitants restés à l'intérieur n'ont pas de sprite : ils apparaissent comme
un **halo jaune cerclé sur leur bâtiment**, avec le nombre d'occupants au
centre. Un quartier peuplé se repère à ses grappes de halos ; un parc ou une
zone industrielle en est dépourvu.

### Se repérer

Tout ce qui est **hors du terrain de jeu est assombri**, et le contour de la
zone est tracé en bleu. Si la zone sort entièrement du champ (facile quand on
zoome fort sur une zone de plusieurs kilomètres), une flèche indique sa
direction : **`F`** ou le bouton **⊡** recadrent dessus.

## Réglages avancés

Tout se règle dans `js/config.js` : vitesses, points de vie, portées, dégâts et
cadence des armes, rayons sonores, densité de population, taille des cellules.

La console expose `sim`, `gameMap` et `renderer` pour bidouiller en direct :

```js
sim.params.zFast = 6.5          // zombies rapides plus rapides
sim.spawnWave(500)              // grosse vague
sim.speed = 4                   // accélérer
renderer.opts.terrain = true    // visualiser la grille de navigation
```

---

## Limites connues

- **Overpass** est un service public et gratuit : il est parfois lent ou
  saturé. L'application bascule automatiquement entre trois miroirs.
- Les bâtiments sont des **volumes pleins** : on ne circule pas à l'intérieur.
  Les occupants sont abstraits (un compteur par bâtiment) jusqu'à ce qu'ils
  sortent.
- Les zombies ne franchissent pas l'eau, ce qui rend les îles et les rives
  très sûres — c'est voulu, mais cela peut déséquilibrer certaines zones.
- Au-delà de ~8 000 entités simultanées, prévoir de rester en vitesse ×1.

---

## Crédits

Fond satellite : **Esri World Imagery** (Maxar, Earthstar Geographics).
Terrain et géocodage : **OpenStreetMap** (contributeurs ODbL), via Overpass et
Nominatim. Cartographie : **Leaflet**.
