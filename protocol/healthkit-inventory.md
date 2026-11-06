# HealthKit data kinds and what Syncky does with them

Every data kind the iOS 27 HealthKit SDK declares, with how an app may read and write it, its typical size in Syncky's wire form and what Syncky does with it.

- SDKs compared on 2026-10-15: `iPhoneOS27.0` (then the default Xcode) and `iPhoneOS27.2` (Xcode 27.2 beta 2); re-checked on 2026-10-18 against `iPhoneOS27.1` (the default Xcode since, the SDK of the core's committed snapshot). The identifier and enum sets are identical: 121 quantity, 72 category (1 deprecated), 6 characteristic identifiers, 86 workout activity cases, 24 other kinds and the 13 enums of the snapshot's `enums` section.
- `HealthKitInventoryTest` (jvm) parses the table below. In the `Kind` column the backticked word is the catalog kind (`quantity`, `category`, `characteristic`, `workout`) or the type name a plan adds. The second column lists the snapshot's `other_kinds` identifiers (or accessors for kinds without a constant); a `*` marks a whole identifier family. `Syncky` starts with `read since plan N`, `plan 11`, `part 2` (issue #8 part 2 or later) or `excluded:`; `part 2` and `excluded` rows name only identifiers that `CatalogExclusions` lists.
- Sizes are the compact JSON of one wire sample (inner protocol v1). Series (routes, heartbeat series) travel in parts of at most 60 000 bytes.

| Kind | SDK identifier or accessor | Read | Write | Typical size | Syncky |
| --- | --- | --- | --- | --- | --- |
| Quantity types `quantity` | `HKQuantityTypeIdentifier*` (121, see `types.json`) | yes, standard read sheet | yes, except the types computed by Apple | ~180 B, 1 value | read since plan 4 |
| Category types `category` | `HKCategoryTypeIdentifier*` (71, see `types.json`) | yes, standard read sheet | yes, except the types computed by Apple | ~175 B, 1 value | read since plan 4 |
| Characteristics `characteristic` | `HKCharacteristicTypeIdentifier*` (6) | yes, standard read sheet | no, set in the Health app | ~105 B, 1 value | read since plan 4 |
| Workout `workout` (activities, events, statistics, metadata) | `HKWorkoutTypeIdentifier` | yes, standard read sheet | yes, `HKWorkoutBuilder` required | ~220 B flat; 1–5 KB with details, bounded to 60 000 B | read since plan 4; details plan 11 |
| Workout route `workout_route` | `HKWorkoutRouteTypeIdentifier` | yes, standard read sheet; locations through `HKWorkoutRouteQueryDescriptor` | yes, `HKWorkoutRouteBuilder` and a saved parent workout | ~130 B per point, ~1 point/s: ~470 KB per hour (~8 parts) | plan 11 |
| Heartbeat series `heartbeat_series` | `HKDataTypeIdentifierHeartbeatSeries` | yes, standard read sheet; beats through `HKHeartbeatSeriesQueryDescriptor` | yes, `HKHeartbeatSeriesBuilder` required | ~10 B per beat, 60–120 beats: ~1.5 KB | plan 11 |
| State of mind `state_of_mind` | `HKDataTypeIdentifierStateOfMind` | yes, standard read sheet | yes | ~350 B | plan 11 |
| Activity summary `activity_summary` | `HKObjectType.activitySummaryType()` | yes, standard read sheet; no anchors, queried by date components | no | ~330 B per day | plan 11 |
| GAD-7 assessment `gad7_assessment` | `HKScoredAssessmentTypeIdentifierGAD7` | yes, standard read sheet | yes | ~330 B, 7 answers | plan 11 |
| PHQ-9 assessment `phq9_assessment` | `HKScoredAssessmentTypeIdentifierPHQ9` | yes, standard read sheet | yes | ~400 B, 9 answers | plan 11 |
| Audiogram `audiogram` | `HKObjectType.audiogramSampleType()` | yes, standard read sheet | yes | ~110 B per test, ≤ 30 points × 2 ears: 2–7 KB | plan 11 |
| Electrocardiogram | `HKObjectType.electrocardiogramType()` | yes, standard read sheet; voltages through a second query per lead | no | ~10 B per voltage, ~15 000 per lead: ~150 KB | part 2 |
| Vision prescriptions (glasses, contacts) | `HKVisionPrescriptionTypeIdentifier` | per-object (`requestPerObjectReadAuthorization`) | yes | ~500 B | part 2 |
| Medication concepts | `HKDataTypeIdentifierUserAnnotatedMedicationConcept` | per-object, iOS 26 API | no | ~300 B | part 2 |
| Medication dose events | `HKMedicationDoseEventTypeIdentifierMedicationDoseEvent` | per-object, iOS 26 API | no | ~250 B | part 2 |
| Clinical records (9) | `HKClinicalTypeIdentifierAllergyRecord`, `HKClinicalTypeIdentifierClinicalNoteRecord`, `HKClinicalTypeIdentifierConditionRecord`, `HKClinicalTypeIdentifierCoverageRecord`, `HKClinicalTypeIdentifierImmunizationRecord`, `HKClinicalTypeIdentifierLabResultRecord`, `HKClinicalTypeIdentifierMedicationRecord`, `HKClinicalTypeIdentifierProcedureRecord`, `HKClinicalTypeIdentifierVitalSignRecord` | health-records entitlement | no | FHIR resource, 1–20 KB | excluded: health-records entitlement and per-record authorization |
| CDA documents | `HKDocumentTypeIdentifierCDA` | per-object (each document) | yes, `HKCDADocumentSample` | XML document, 10–200 KB | excluded: clinical documents outside the sample wire format |
| Blood pressure correlation | `HKCorrelationTypeIdentifierBloodPressure` | yes, standard read sheet | yes, a correlation of systolic and diastolic samples required | 2 quantities, ~400 B | part 2 (systolic and diastolic are read as quantities) |
| Food correlation | `HKCorrelationTypeIdentifierFood` | yes, standard read sheet | yes, a correlation of dietary samples required | n dietary quantities, ~180 B each | part 2 (dietary quantities are read individually) |
