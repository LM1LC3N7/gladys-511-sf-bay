# Transports de la baie de San Francisco

Les **prochains départs** et les **alertes de service** à cinq arrêts au plus
de la baie de San Francisco (Muni, BART, Caltrain, AC Transit, SamTrans, VTA,
Golden Gate Transit, traversiers…), dans Gladys. Données fournies par
511.org ([511.org](https://511.org/)).

Cette intégration n’est pas officielle : elle n’est liée ni à 511, ni à la
MTC, ni à aucun opérateur, et ce n’est **pas une source officielle**.
Vérifiez sur 511.org ou auprès de l’opérateur avant de partir. Elle n’a
jamais été testée avec un vrai jeton 511 ni sur une vraie installation de
Gladys par son auteur : elle a été écrite d’après la spécification de 511 et
testée contre un 511 simulé qui la suit.

## Démarrer en 4 étapes

1. **Obtenez un jeton 511 gratuit** sur
   [511.org/open-data/token](https://511.org/open-data/token) : il arrive par
   e-mail. Accepter les conditions de 511 est votre choix : c’est vous qui
   recevez les données.
2. **Trouvez votre arrêt.** Il faut l’identifiant 511 de l’opérateur et le
   code de l’arrêt :

   | Opérateur    | Id   |
   | ------------ | ---- |
   | Muni (SFMTA) | `SF` |
   | BART         | `BA` |
   | Caltrain     | `CT` |
   | AC Transit   | `AC` |
   | SamTrans     | `SM` |
   | VTA          | `SC` |
   | Golden Gate  | `GG` |

   Le code est sur le panneau de la plupart des arrêts de bus (Muni : 5
   chiffres, ex. `15553`) et dans la liste des arrêts de l’opérateur sur
   511.org. Le code d’une station parente donne tous ses quais.

3. **Installez l’intégration** depuis le catalogue, collez le jeton dans
   **Jeton 511**, saisissez l’opérateur et le code dans **Arrêt 1**, et
   enregistrez.
4. Ouvrez l’onglet **Découverte** et cliquez sur **Ajouter** sur l’arrêt.

**Un appareil par arrêt.** Un appareil appartient à un emplacement, à son
opérateur et à son code : un autre arrêt dans un emplacement propose un
nouvel appareil ; l’ancien n’est plus mis à jour (supprimez-le dans Gladys).
Changer le filtre de lignes garde l’appareil.

## Le quota du jeton

Un jeton 511 permet **60 requêtes par heure** par défaut (511 peut le relever
sur demande : saisissez votre limite dans **Limite horaire de votre jeton**).
L’intégration :

- lit chaque arrêt avec **une requête** par lecture (511 répond pour un arrêt
  par requête), et les alertes avec **une requête par opérateur** toutes les
  15 minutes ou plus ;
- planifie les intervalles pour qu’**aucune heure ne dépasse 90 %** de votre
  limite : avec la limite par défaut, 1 arrêt toutes les 5 minutes et ses
  alertes font 16 requêtes par heure ; 5 arrêts de 3 opérateurs sont lus
  toutes les 8 minutes (52 par heure). Si votre intervalle ne tient pas, il
  est allongé et le statut le dit ;
- **compte chaque requête envoyée** et n’en envoie aucune quand la dernière
  heure contient déjà 90 % de la limite (elle attend 2 minutes au plus qu’une
  place se libère, sinon cette lecture est sautée et le statut le dit). Le
  compte est écrit dans `/data` avant le départ de la requête : un
  redémarrage le connaît. Si `/data` ne peut pas le dire (fichier illisible),
  les premières lectures attendent un intervalle ;
- arrête toute lecture quand 511 répond **429** : le temps qu’il demande,
  10 minutes au moins (doublées aux suivantes), 6 heures au plus, même après un
  redémarrage ; une erreur **5xx** ou un autre refus des départs (403…) met
  toutes les lectures en pause 2 minutes (doublées, 6 heures au plus) ; une
  lecture des alertes en échec attend 15 minutes, puis 30, 60, 120 pour cet
  opérateur seulement, même après un redémarrage (l’heure de la tentative est
  écrite dans `/data` avant le départ de la requête).

La Découverte, le bouton **Voir les dernières lectures** et l’enregistrement
d’une configuration inchangée ne lisent jamais 511 (enregistrer à nouveau ne
fait que réessayer une fois un jeton refusé avant un redémarrage).

## Ce que contient chaque appareil

Le nom de la fonction **Prochain départ** finit par « (data provided by
511.org) », les autres par « (511.org) » : l’attribution que 511 demande, mot
pour mot, à côté des données. Les minutes d’un texte sont comptées à l’heure
de la lecture : avec un long intervalle, lisez l’heure (`10:03`), qui reste
juste.

- **Prochain départ** et **Départ suivant** : textes avec la ligne, la
  destination, les minutes d’attente (comptées sur l’heure de la réponse de 511) et l’heure, ex. `14 MISSION → Downtown: 3 min (10:03)` ;
  `, horaire prévu` quand l’opérateur ne donne que l’horaire théorique. S’il
  n’y en a pas : `Aucun départ prévu (lu à 10:05)`. Ce sont des textes pour
  qu’un départ disparu ne reste jamais affiché comme un nombre.
- **Départs dans les 60 min** : un compteur, pour les scènes.
- **Alertes de service** : le nombre d’alertes en vigueur pour l’arrêt, ses
  lignes ou tout son opérateur.
- **Alerte** : le texte de la première, ex. `Line 49 detour. (+1 autre)`, ou
  `Aucune alerte (lu à 10:05)`.

Les **lignes d’un arrêt**, pour les alertes, sont celles du filtre, sinon
celles que 511 a montrées à l’arrêt (gardées 7 jours). Tant qu’aucun départ
n’a été vu, le nombre d’alertes de l’arrêt attend (le statut le dit) : un
compte fait sans les lignes de l’arrêt manquerait leurs alertes. Une ligne
qui n’est pas passée à l’arrêt depuis 7 jours est oubliée.

## Jamais une valeur inventée

- Un flux d’alertes sans heure d’en-tête n’est pas utilisé (son âge est
  inconnu) : jamais « Aucune alerte » à partir de lui.
- Un filtre de lignes qui ne correspond à aucun départ montré par 511 à
  l’arrêt, trois lectures de suite, est signalé dans le statut : vérifiez les
  noms des lignes.

- Une lecture en échec, une réponse illisible (un départ dont l’heure ne se
  lit pas refuse toute la réponse), une réponse dont l’heure diffère de plus
  de 5 minutes de l’horloge de la machine : **rien n’est publié**, jamais 0 ;
  le statut dit pourquoi et depuis quand.
- « Aucun départ prévu » n’est publié que pour un arrêt où 511 a déjà montré
  un départ : un code mal saisi ressemblerait sinon à un arrêt vide.
- Un arrêt auquel 511 répond 404 (inconnu) est réessayé 30 minutes plus
  tard ; les autres arrêts continuent.
- Un jeton refusé (401 à une lecture des départs) arrête toute lecture et
  est retenu (une courte empreinte dans `/data`, jamais le jeton) :
  **enregistrez un nouveau jeton** pour relire. Un 401 à une lecture des
  alertes n’est pas pris pour un jeton refusé.

## Vie privée

Le jeton est gardé par Gladys dans sa base, jamais réaffiché, envoyé
seulement à 511.org, jamais écrit dans les journaux, le statut ni `/data`.
Les codes de vos arrêts ne sont écrits dans `/data` que sous forme
d’empreintes salées ; les identifiants d’opérateur et les lignes vues à un
arrêt y sont en clair (aucune donnée personnelle).

## Licence et données

Le code est sous licence Apache 2.0. Les données sont fournies par 511.org
(Metropolitan Transportation Commission) selon le 511 Data Disseminator
Agreement que vous acceptez avec votre jeton : données fournies par 511.org,
sans garantie, sans logo d’opérateur. L’intégration n’utilise pas « 511 »
comme marque.
