# Sondages Présidentielle 2027

Moyenne des sondages pour l'élection présidentielle française de 2027 (premier tour le 18 avril, second tour le 2 mai 2027), mise à jour automatiquement.

**👉 Voir le site : <https://lcarwy.github.io/presidentielle-2027/>**

## Fonctionnalités

- **Moyenne actuelle** des intentions de vote au premier tour, avec l'évolution sur la période choisie et la fourchette des sondages récents.
- **Graphique d'évolution** : moyenne lissée et sondages individuels, infobulle au survol (ou au clavier), légende cliquable pour masquer une personnalité.
- **Scénarios** : filtrer les hypothèses (« avec Édouard Philippe », « avec Gabriel Attal »…) ; la moyenne, le graphique et le tableau se recalculent.
- **Second tour** : moyenne des duels testés sur les 60 derniers jours.
- **Tableau de tous les sondages**, filtrable par institut, avec le détail de chaque hypothèse, la marge d'erreur au survol et un lien vers la notice officielle.
- Export **CSV / JSON**, lien partageable (les filtres sont dans l'URL), thème clair / sombre, affichage mobile.

## Fonctionnement

```
scripts/update_polls.py      lit la page Wikipédia et écrit data/sondages.json + data/sondages.csv
.github/workflows/…          relance le script toutes les 3 heures, enregistre les changements, publie le site
index.html, assets/          site statique (aucune dépendance) qui calcule la moyenne dans le navigateur
```

Source des données : [Liste de sondages sur l'élection présidentielle française de 2027](https://fr.wikipedia.org/wiki/Liste_de_sondages_sur_l%27%C3%A9lection_pr%C3%A9sidentielle_fran%C3%A7aise_de_2027) (Wikipédia, licence CC BY-SA 4.0), alimentée par les notices de la [Commission des sondages](https://www.commission-des-sondages.fr/).

Le script refuse d'écraser les données si le nombre de sondages extraits chute brutalement (page vandalisée ou restructurée) ; le site continue alors d'afficher les dernières données valides.

### Méthode de la moyenne

1. Pour chaque sondage, moyenne des scores d'une personnalité sur les hypothèses où elle figure (filtrées par le scénario choisi).
2. Lissage par noyau gaussien (écart-type de 12 jours) ; à la date du jour, seuls les sondages passés comptent.
3. Pondération par la racine carrée de la taille de l'échantillon et plafonnement du poids total de chaque institut (« un institut, une voix »).

### Couleurs

Les couleurs suivent les usages politiques (RN violet-bleu, LFI rouge, PS-Place publique framboise, Horizons turquoise, LR bleu, Renaissance jaune, Écologistes vert, Reconquête gris foncé) et ont été vérifiées pour la lisibilité par les personnes daltoniennes ; les autres personnalités sont en gris et toujours nommées.

## Développement local

```bash
python3 scripts/update_polls.py     # met à jour data/
python3 -m http.server 8000         # puis http://localhost:8000
```

## Mise en ligne sur GitHub Pages

1. Pousser le dépôt sur GitHub.
2. *Settings → Pages → Build and deployment → Source* : **GitHub Actions**.
3. Le workflow « Mise à jour et publication » publie le site à chaque push et toutes les 3 heures (il peut aussi être lancé à la main depuis l'onglet *Actions*).

> Un sondage n'est pas une prévision : c'est une photographie de l'opinion à un instant donné.
