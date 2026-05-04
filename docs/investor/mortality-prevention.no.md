# AquaPlatform — Mekanismer for Reduksjon av Dødelighet

> Dette er et ikke-teknisk referansedokument utarbeidet for investorer, partnere og beslutningstakere. Systemets kapasitet til å redusere fiskedødelighet beskrives gjennom moduler som er i drift, og moduler som er planlagt.

---

## 1. Kontekst

I akvakultur er dødelighet den primære variabelen som bestemmer driftens lønnsomhet. Bransjegjennomsnittet ligger i området 15–40 % per år. Investeringer i biomasse, fôr, arbeidskraft og energi går uopprettelig tapt sammen med fisken som dør.

AquaPlatform er en SaaS-løsning som bryter dødelighetskjeden på flere punkter. Plattformen er konstruert slik at en og samme organisasjon kan administrere flere uavhengige anlegg, lokaliteter og regioner under samme operasjonssentral, med felles dødelighetskontroll og isolerte data. Avsnittene nedenfor beskriver systemets kapasitet i operative termer; tekniske referanser er holdt på et minimum.

---

## 2. Hovedfunksjoner

### 2.1 Doseringsmotor for Vannkjemi

Systemet beregner konsentrasjonen av uionisert ammoniakk (NH₃), karbondioksid og hydrogensulfid ved hjelp av referanseligninger fra den vitenskapelige litteraturen, basert på temperatur, pH, alkalinitet, saltholdighet og total ammoniakknitrogen. Resultatet presenteres for operatøren ikke som rådata, men som en konkret doseringsoppskrift:

> *"Det skal tilsettes 12,4 kg natriumbikarbonat til Tank A. Resultat: pH 7,2 → 7,4, NH₃ holder seg innenfor sikre grenser, CO₂ kommer ut av den kritiske sonen."*

Doseringsmotoren beregner toksisitetsterskler i sanntid på nytt når temperatur, pH og saltholdighet endres samtidig.

### 2.2 Samlet Fasediagram

Toksisitetssoner for NH₃, CO₂ og H₂S tegnes på samme lerret, langs alkalinitet–DIC-aksene:

- Grønn sone: trygt driftsområde
- Røde soner: områder hvor toksisitetsgrensene overskrides
- Blått punkt: tankens øyeblikkelige tilstand
- Målpunkt: ønsket vannkjemi
- Retningspiler: hvilken vei kjemikaliet flytter tanken når det tilsettes

I stedet for å sammenstille fem separate parametergrafer mentalt, leser operatøren tankens avstand til den trygge sonen fra ett enkelt visuelt bilde.

### 2.3 Forvaltning av Optimal Sone

Systemet har som mål å holde tanken innenfor den trygge fasesonen. Når et avvik begynner, genererer det en gjenopprettingsplan med flere kjemikaliealternativer; for hvert alternativ angis mengden i gram, et anvendbarhetsnotat og en risikoskår. Operatøren velger den mest hensiktsmessige veien.

Oppskriften påføres ikke i én enkelt operasjon, men trinnvis:

1. Systemet deler oppskriften i deltrinn og viser det forventede resultatet av hvert trinn på forhånd.
2. Operatøren utfører første trinn.
3. En ny vannprøve måles og legges inn i systemet.
4. Systemet sammenligner forventning med faktisk resultat; ved avvik beregnes resterende trinn på nytt.
5. Sløyfen gjentas til prosedyren er fullført.

Denne arbeidsformen utelukker strukturelt det pH- eller alkalinitetssjokket som kan oppstå ved enkeltdoseoverdosering.

### 2.4 Utstyrsattribusjon

Hver oppskrift systemet anbefaler, leveres med en liste over nødvendig utstyr (CO₂-flaske, doseringslinje, avgassingsenhet, doseringspumpe og lignende). I tillegg blir utstyret som har forårsaket avviket (for eksempel en avgassingsenhet ute av drift eller en stoppet luftpumpe) varslet til operatøren. Tiden brukt på å lokalisere det defekte utstyret reduseres takket være denne attribusjonen.

### 2.5 Satellittbasert Miljøovervåking (Merd-Anlegg)

To separate satellittkilder er integrert i systemet:

- **Sentinel-2 / Copernicus Data Space Ecosystem (optisk):** faktiske bilder av kystvannet ved anleggets koordinater; klorofyllkonsentrasjon, indikasjoner på algeoppblomstring og fargeavvik i vannet.
- **Copernicus Marine CMEMS (modell):** havoverflatetemperatur (SST), saltholdighet og strømvarsel.

Den optiske kilden gir nåværende status, modellkilden den fremtidige. Skadelige algeoppblomstringer og temperaturanomalier varsles 48–72 timer på forhånd; merdoperasjonene (notdybde, høstetidspunkt) kan justeres deretter.

### 2.6 Lot-Basert Sporbarhet

Fôr- og kjemikalielot spores med minutters presisjon fra inntak til forbruk. Når to ulike lot blandes i samme silo, merkes hendelsen som "MIX-LOT1-LOT2". Etter en dødelighetshendelse spores kilden tilbake i samsvar med EUs næringsmiddelsikkerhetsstandard for to-timers tilbakesporing. Påvirkningsområdet til en defekt eller utløpt lot på anlegget begrenses dermed.

### 2.7 Sykdomsforhåndsvarsling Basert på Vitenskapelig Kunnskap

Fiskesykdommer er i stor grad knyttet til miljømessige utløsere. Eksempler:

- Lav vanntemperatur over lengre tid øker risikoen for kaldtvannssykdom (BCWD) og IPN hos laks.
- Temperaturer over 18 °C øker risikoen for vibriose hos havabbor og dorade.
- Kombinasjonen av lavt oksygen og høyt ammoniakk svekker immunforsvaret.
- Saltholdighetsjokk kan tilrettelegge for soppinfeksjoner.

AquaPlatform har som mål å gi vitenskapelig forankrede varsler til driftsleder når miljøparametrene går inn i slike risikomønstre:

> *"I Tank 7 har vanntemperaturen vært under 8 °C i 5 dager. Arten som oppdrettes er atlantisk laks. Eksisterende litteratur (Holt 1972, Starliper 2011) dokumenterer at risikoen for BCWD øker under disse forholdene."*

Hvert varsel leveres med kildereferanse; informasjonen som videreformidles, hviler dermed på et sporbart vitenskapelig grunnlag.

**Behandlingspakke:**

I tillegg til risikovarsling samler systemet behandlingsinformasjonen på samme skjerm:

- Anbefalte legemidler og doser (artsspesifikt, vekt-spesifikt, sykdomsspesifikt)
- Tilbaketrekkingstid (withdrawal period — påkrevd innenfor næringsmiddelsikkerhet)
- Varsler om interaksjon mellom legemidler og mellom legemidler og vannkjemi
- Register over autoriserte fiskeveterinærer med direkte kontaktmulighet
- Leverandørintegrasjon for legemiddelanskaffelse
- Behandlingsplan (doseintervaller, kontrollobservasjoner)

**Kunnskapsbasens Struktur:**

Systemet er bygget på en arkitektur der vitenskapelige artikler kan lastes opp i kunnskapsbasen. Artsspesifikke sykdom–betingelse-forhold, miljøutløser-terskler, vekstkurver og behandlingsprotokoller legges til over tid. Når en ny studie lastes opp, oppdateres beskyttelsen for samtlige tenants samtidig.

**Moduler i Drift og Planlagte Moduler:**

| Modul | Status |
|---|---|
| Sykdomshendelseslogg (symptomkategorier) | I drift |
| Behandlingslogg, legemiddelnavn, start- og sluttdato | I drift |
| Sporing av tilbaketrekkingstid | I drift |
| Sperre for høsting og overføring av syke tanker | I drift |
| Sporing av miljøparametre | I drift |
| Korrelasjonsmotor på tvers av domener | I drift |
| Vitenskapelig forankret bibliotek for sykdom–betingelse | Planlagt |
| Automatisk prediktiv sykdomsvarsling | Planlagt |
| Artsspesifikk sykdomsrisikoskår | Planlagt |
| Bibliotek for legemiddel- og doseanbefalinger | Planlagt |
| Interaksjon legemiddel–legemiddel og legemiddel–vannkjemi | Planlagt |
| Register over autoriserte veterinærer | Planlagt |
| Leverandørintegrasjon | Planlagt |
| Automatisering av behandlingsplan | Planlagt |

### 2.8 Forvaltning av Flere Uavhengige Anlegg

AquaPlatform er konstruert som en flertenant-arkitektur. En enkelt operasjonell organisasjon — en oppdrettsgruppe, et regionkontor eller et konsern — kan administrere flere geografisk uavhengige anlegg, lokaliteter og regioner gjennom samme plattform, mens dataene mellom anleggene holdes isolert på databasenivå.

I praksis betyr dette:

- Hver lokalitet har sine egne tanker, arter, sensorer, ansatte og rapporter.
- En ledelse på konsernnivå kan se alle anlegg i én konsolidert oversikt; risikoskår, dødelighetstall, fôringsavvik og vedlikeholdsstatus aggregeres samtidig på tvers av lokaliteter.
- Doseringsoppskrifter, sykdomsvarsler og vedlikeholdsprosedyrer som tas i bruk på ett anlegg, kan kopieres som mal til andre anlegg.
- Vakthavende personale kan overvåke flere anlegg under én vaktordning, med felles eskaleringsstige.
- Kunnskapsbase-oppdateringer (nye sykdomsartikler, oppdaterte tersklene) trer i kraft samtidig på alle anlegg under organisasjonen.

Resultatet er at samme dødelighetskontroll og operative disiplin kan opprettholdes i hele porteføljen uten at hvert anlegg trenger å bygge sin egen separate styringsstruktur.

---

## 3. Arkitektur for Kunstig Intelligens

I systemet utfører kunstig intelligens ikke kjemiske beregninger eller doseringsmengder selv. Alle numeriske beregninger utføres av deterministiske verktøy bygget på bisection-algoritmer, dissosiasjonskonstanter fra Millero (1995, 2010) og likninger for karbonatsystemet. Den kunstige intelligensen kaller disse verktøyene og videreformidler resultatet uendret.

Denne arkitekturen gir to konsekvenser:

1. Tallene som produseres, er identiske ved samme inngangsdata; de er reproduserbare og verifiserbare.
2. Hallusinasjonsrisikoen ved språkmodeller overføres ikke til doseringsbeslutninger som er kritiske for fiskens overlevelse.

Kunstig intelligens benyttes i rollene daglig driftsbrief, rotårsaksanalyse, anomalidetektering og operatørassistent. I disse rollene kjører deterministiske verktøy alltid i bakgrunnen.

---

## 4. Operatør- og Feltkomponenter

### 4.1 Mobilapplikasjon (AquaMobil)

- Kritiske varsler når operatørens enhet i løpet av sekunder via push-varslingsinfrastrukturen.
- Vannkvalitetsmålinger registreres ved tanken; systemet validerer verdiene umiddelbart og merker dem som ligger utenfor grenser.
- Dødelighetslogger registreres via tretten forhåndsdefinerte kategorier; strukturerte data samles inn i stedet for fritekst.
- Ved fôringslogger utløser et avvik på ±20 % fra plan automatisk varsling.
- Når internettforbindelsen mangler, lagres dataene lokalt på enheten og synkroniseres når forbindelsen kommer tilbake.
- I felten kan operatøren be AI-assistenten om konkrete instruksjoner.
- Mobile arbeidsordrer lukkes med fotodokumentasjon.

### 4.2 HR og Tilgangsstyring

- Personell med utløpt sertifikat tildeles ikke kritiske oppgaver i systemet.
- Vaktstyring fungerer sammen med en eskaleringsstige: dersom et varsel ikke håndteres av operatøren i tide, eskaleres det til driftsleder.
- Personalets kompetanse spores via tjenesten for opplæring og sertifisering.

### 4.3 Vedlikehold av Utstyr

- Periodiske vedlikeholdsplaner for pumper, luftere og filtre genererer arbeidsordrer automatisk.
- Vedlikeholdsutfallet dokumenteres med fotobevis.

---

## 5. Nitten Mekanismer Som Direkte Reduserer Dødelighet

Punktene nedenfor oppsummerer i operativ form systemets kapasitet til å redusere fiskedødelighet direkte.

1. Systemet måler tankens vann kontinuerlig og varsler i det øyeblikket verdiene begynner å forverres.
2. Systemet vurderer giftige stoffer i vannet sammen med temperatur, pH og saltholdighet.
3. Systemet beregner i gram hvor mye av hvilket kjemikalium som skal tilsettes.
4. Systemet tilbyr flere kjemikaliealternativer for samme problem og merker det tryggeste.
5. Systemet deler oppskriften i kontrollerte deltrinn i stedet for én operasjon.
6. Systemet viser det forventede resultatet av hvert trinn på forhånd.
7. Systemet sammenligner forventning med faktisk måling etter dosering, og beregner oppskriften på nytt ved avvik.
8. Systemet samler statusen for alle giftige stoffer i én graf.
9. Systemet tegner det trygge driftsområdet og varsler når tanken begynner å bevege seg ut av området.
10. Systemet gjør operatøren oppmerksom på utstyret som har forårsaket avviket.
11. Systemet anvender artsspesifikke grenser automatisk.
12. Systemet tillater ikke at biomassen overskrider tankens kapasitet.
13. Systemet kan utløse av- og påslag av luftpumpe eksternt.
14. Systemet lagrer kritiske varsler i en holdbar kø mot tap.
15. Systemet forhindrer overføring av fisk fra en syk tank til en annen tank.
16. Systemet leverer kritiske varsler til operatørens enhet i løpet av sekunder.
17. Systemet validerer feltmålte verdier umiddelbart.
18. Systemet fortsetter å registrere data også ved manglende internettforbindelse.
19. Systemet merker fôringsavvik automatisk med et varsel.

---

## 6. Sytten Mekanismer Som Indirekte Reduserer Dødelighet

Punktene nedenfor er mekanismer som forhindrer dødelighet ved å redusere operatørfeil eller forsinkede beslutninger.

20. Systemet analyserer årsaken til en dødelighetshendelse retrospektivt.
21. Systemet leverer hver morgen en risiko- og anomalirapport for hele anlegget til driftsleder.
22. Systemet gir operatøren handlingsforslag på ekspertnivå i felten.
23. Systemet produserer ikke numeriske feil fra kunstig intelligens; alle beregninger kommer fra deterministiske verktøy.
24. Systemet overvåker fôrlagernivået og varsler om bestilling før beholdningen tar slutt.
25. Systemet kan isolere utløpt eller bedervet fôrlot fra forbrukssyklusen.
26. Systemet styrer vedlikeholdsplanen for utstyr automatisk.
27. Systemet tildeler ikke kritiske oppgaver til personell med utløpt sertifikat.
28. Systemet driver eskaleringsregler slik at ingen varsler blir liggende uten ansvarlig.
29. Systemet utfører miljørisikoovervåking fra satellitt for merd-anlegg.
30. Systemet integrerer værdata i driftsplanleggingen.
31. Systemet registrerer dødelighetslogg via tretten forhåndsdefinerte kategorier; datakvaliteten ivaretas.
32. Systemet lukker vedlikeholdsarbeidsordrer med fotodokumentasjon.
33. Systemet flagger små miljøavvik tidlig via anomalidetektering.
34. Systemet produserer en 48-timers risikoskår for hver tank.
35. Systemet reduserer driftsleders arbeidsbelastning for datainnsamling via en samlet visning.
36. Systemet gjør det mulig å forvalte flere uavhengige anlegg under samme operasjonelle disiplin og dødelighetskontroll, uten at dataene blandes.

---

## 7. Transparensmerknad

Dette dokumentet skiller systemets nåværende kapasitet fra moduler i veikartet. Modulene under "I drift" fungerer i dag; modulene under "Planlagt" er under aktiv utvikling.

Den kvantitative effekten på dødelighet (prosentvis reduksjon, tilbakebetalingstid og lignende) bestemmes gjennom anleggsspesifikke pilotmålinger; dette dokumentet inneholder ikke generelle tallforpliktelser. Målingsmetodikk og pilotprosess dokumenteres separat.

Mekanismene systemet anvender for å redusere fiskedødelighet og områdene som fortsatt er under utvikling, er oppsummert objektivt ovenfor. Den operative brukeren kan henvende seg til produktteamet for detaljert teknisk dokumentasjon om hvordan en spesifikk modul fungerer.
