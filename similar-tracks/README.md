# Similar Tracks

Γράφεις τίτλο ή βάζεις link (YouTube, SoundCloud, Spotify, Beatport, Bandcamp) και βλέπεις:

- **Παρόμοια**: τραγούδια με ίδιο vibe/στυλ
- **Ίδιο κομμάτι / remixes**: άλλες εκδόσεις, remixes, edits
- **Ίδιος καλλιτέχνης**: τα πιο δημοφιλή του καλλιτέχνη

Κάθε αποτέλεσμα έχει preview 30" (όπου υπάρχει) και συνδέσμους αναζήτησης σε YouTube, SoundCloud, Beatport, Bandcamp και Spotify.

## Εκτέλεση στον υπολογιστή σου

1. Εγκατάστησε το Node.js (έκδοση 18 ή νεότερη): https://nodejs.org
2. Άνοιξε τερματικό μέσα στον φάκελο και τρέξε:

   ```
   node server.js
   ```
3. Πήγαινε στο http://localhost:3000

Δεν χρειάζεται `npm install`, δεν υπάρχουν εξαρτήσεις.

## Καλύτερες προτάσεις με Last.fm (προαιρετικό, δωρεάν)

1. Φτιάξε API key στο https://www.last.fm/api/account/create
2. Τρέξε:

   - Mac/Linux: `LASTFM_API_KEY=το_κλειδί_σου node server.js`
   - Windows (PowerShell): `$env:LASTFM_API_KEY="το_κλειδί_σου"; node server.js`

Χωρίς key, οι προτάσεις βγαίνουν από τους «σχετικούς καλλιτέχνες» του Deezer, που δουλεύει αλλά είναι λιγότερο ακριβές για underground ηλεκτρονική.

## Ανέβασμα online

Δουλεύει σε οποιαδήποτε υπηρεσία που τρέχει Node (π.χ. Render, Railway, Fly.io). Start command: `node server.js`. Πρόσθεσε το `LASTFM_API_KEY` ως environment variable.

## Πώς δουλεύει

- Τα links αναγνωρίζονται με oEmbed (YouTube, SoundCloud), Odesli/song.link (Spotify κ.ά.) και ανάγνωση του τίτλου της σελίδας (Beatport, Bandcamp).
- Το κομμάτι αναζητείται στο Deezer, που δίνει καλύμματα, previews και σχετικούς καλλιτέχνες χωρίς key.
- Αν υπάρχει Last.fm key, προστίθενται προτάσεις βάσει του τι ακούνε οι ίδιοι ακροατές.

## Περιορισμοί

- Το Deezer δεν έχει ολόκληρο το underground κατάλογο (π.χ. κομμάτια που υπάρχουν μόνο σε Bandcamp/SoundCloud). Σε αυτή την περίπτωση γράψε «Καλλιτέχνης - Τίτλος» ή δοκίμασε ένα πιο γνωστό κομμάτι του ίδιου καλλιτέχνη.
- Οι προτάσεις βασίζονται σε metadata και συμπεριφορά ακροατών, όχι σε ανάλυση του ήχου.
