# OpenMercato ITAD

OpenMercato ITAD is a workflow system for IT Asset Disposition companies.

It helps teams manage customer jobs from the moment a pickup is planned, through receiving and reconciliation, to data sanitization, exception handling and customer-facing certificates.

The goal is simple:

> Every device should have a clear, traceable story — what was expected, what arrived, what happened to it, whether its data was sanitized, what exceptions occurred and what evidence can be shown to the customer.

---

## Who is it for?

OpenMercato ITAD is designed for companies that receive, process and disposition used IT equipment for business customers.

Typical users include:

- ITAD providers
- electronics reuse and refurbishment companies
- secure data destruction providers
- asset recovery companies
- recycling operators handling data-bearing equipment
- operations teams processing customer device refreshes and returns

It is especially useful where the process involves many devices, multiple operators and a need for strong traceability.

---

## The workflow

A typical ITAD job moves through the following stages:

Customer  
↓  
Job  
↓  
Pickup  
↓  
Manifest  
↓  
Receiving  
↓  
Reconciliation  
↓  
Asset Processing  
↓  
Data Sanitization  
↓  
Exception Resolution  
↓  
Certificates & Documents  
↓  
Closeout

The system keeps these stages connected, so users do not have to reconstruct what happened from spreadsheets, emails and separate tools.

---

## Jobs

Each customer engagement is managed as an ITAD Job.

A job contains the operational context for the work, including:

- customer
- internal reference
- customer reference
- planned pickup
- expected assets
- received assets
- processing status
- exceptions
- required documents

The job progresses through a controlled lifecycle from planning to completion.

This makes it clear which jobs are ready for the next stage and which still require attention.

---

## Pickup planning

A scheduled pickup can appear in the operational calendar.

The pickup remains linked to the ITAD Job, so scheduling changes are managed from the job rather than maintained independently in multiple places.

This allows operations teams to see upcoming collections without turning the calendar into a second source of truth.

---

## Manifest import

Customers often provide a list of equipment before collection.

OpenMercato ITAD supports importing an expected asset manifest and using it during receiving.

The manifest can contain information such as:

- serial number
- customer asset tag
- manufacturer
- model
- other customer-provided device data

The imported manifest becomes the baseline against which the physical delivery is reconciled.

---

## Receiving and reconciliation

During receiving, each physical device is recorded and matched against the expected manifest.

The system can distinguish between:

- expected devices that arrived
- expected devices that are missing
- unexpected devices
- duplicate scans

This gives operations teams a clear reconciliation view instead of requiring manual comparison between spreadsheets and warehouse records.

Example:

Expected: 100 devices  
Received: 98 expected devices  
Missing: 2  
Unexpected: 3  
Duplicate scans: 1

These differences remain visible and traceable throughout the job.

---

## Asset tracking

Each physical device becomes an Asset in the job.

The asset acts as the central record connecting:

- manifest information
- receiving history
- customer asset identifiers
- data-bearing classification
- sanitization activity
- exceptions
- certificates

This allows users to open a single device and understand its history without searching across separate systems.

---

## Data-bearing classification

Assets can be classified according to whether they contain customer data.

This classification determines whether data sanitization is required.

For example:

Non-data-bearing asset  
→ no sanitization certificate required

Data-bearing asset  
→ sanitization required before closeout

This prevents unnecessary processing while ensuring that devices containing data cannot silently bypass the sanitization workflow.

---

## Data sanitization

Data-bearing devices move through a controlled sanitization process.

A sanitization record can capture:

- sanitization method
- method details
- tool used
- tool version
- start time
- completion time
- result
- verification method
- supporting evidence
- media identifiers
- who started the process
- who recorded the result

Typical results include:

PASS  
FAIL  
ABORTED

A successful result allows the asset to become sanitized.

A failed result moves the device into review rather than allowing it to disappear into the workflow.

The system is intended to work alongside specialist sanitization tools rather than replace them.

---

## Exceptions

Operational problems are treated as explicit exceptions.

Examples include:

- an expected device did not arrive
- an unexpected device arrived
- the same device was scanned twice
- sanitization failed

Exceptions remain open until they are resolved through an appropriate business action.

This gives operations managers a single place to answer:

> What is preventing this job from being completed?

Instead of relying on notes or operator memory, unresolved issues are part of the workflow itself.

---

## Certificates of Data Sanitization

For successfully sanitized devices, OpenMercato ITAD can issue a Certificate of Data Sanitization.

Each certificate covers one device and is based on a recorded successful sanitization run.

A certificate can include:

- customer
- job reference
- device serial number
- customer asset tag
- media identifiers
- sanitization method
- tool
- tool version
- result
- verification method
- completion time
- users involved in the recorded workflow
- unique certificate number

Example certificate number:

`CDS-2026-00001`

The certificate is generated from recorded workflow data rather than typed manually.

Once issued, the document remains unchanged.

If a correction is required, a new certificate is issued and the previous one remains in history as superseded or void.

This creates a clear audit trail for customer-facing documentation.

---

## Bulk certificate issuing

Large jobs may contain dozens or hundreds of devices.

Instead of issuing certificates one at a time, users can issue all missing certificates for eligible devices in a job.

Each device still receives its own certificate.

If some devices cannot receive a certificate, the system reports those assets individually without preventing the remaining valid certificates from being created.

---

## Job closeout

A job cannot be completed merely because an operator clicks a confirmation checkbox.

The system checks the actual operational state.

For example, completion may require:

- receiving to be complete
- assets to be processed
- blocking exceptions to be resolved
- required sanitization to be complete
- required certificates to exist

If ten devices require sanitization certificates and only nine have one, the job remains incomplete.

This makes closeout a result of the recorded process rather than a manual declaration.

---

## Auditability

OpenMercato ITAD is designed around traceability.

For important actions, the system preserves the history of what happened.

Examples include:

- job status changes
- intake scans
- reconciliation results
- exception creation and resolution
- sanitization attempts
- sanitization results
- certificate issuance
- certificate replacement
- certificate voiding

The aim is to make it possible to answer:

> What happened to this device?

> When did it happen?

> Who recorded it?

> What evidence supports it?

---

## Example

A customer sends a manifest containing 50 laptops.

During receiving:

- 48 expected laptops arrive
- 2 are missing
- 1 additional laptop arrives unexpectedly

The received devices are classified.

42 contain data and require sanitization.

During processing:

- 40 pass sanitization
- 2 fail and require review

One failed device is successfully retried.

The other is investigated and resolved by an operations manager.

Once all blocking exceptions are resolved and all required devices have valid sanitization certificates, the job can move to completion.

The customer receives a traceable outcome based on the same operational records used by the processing team.

---

## Why OpenMercato ITAD?

Many ITAD workflows are still spread across:

- spreadsheets
- warehouse notes
- sanitization tools
- shared drives
- email
- CRM systems
- manually prepared certificates

The problem is often not the absence of individual tools.

The problem is that the tools do not represent the full operational process.

OpenMercato ITAD is intended to provide that process layer:

**one job, one asset history and one traceable workflow from collection to customer evidence.**

---

## Current scope

The current project covers:

- customer ITAD jobs
- pickup scheduling
- manifest import
- receiving
- manifest reconciliation
- asset tracking
- data-bearing classification
- data sanitization
- sanitization evidence
- operational exceptions
- per-device Certificates of Data Sanitization
- job closeout controls

---

## Future areas

Potential future extensions include:

- device grading
- disposition routing
- refurbishment
- resale and value recovery
- recycling workflows
- chain of custody
- settlement with customers
- job completion reports
- certificate packs
- direct integrations with sanitization providers
- customer portal access

---

## Project status

OpenMercato ITAD is currently being developed as a domain-focused ITAD application on the OpenMercato platform.

The project is being built iteratively around real operational scenarios, with each workflow designed to preserve traceability and prevent important steps from being bypassed.

The long-term goal is not simply to track devices.

It is to provide an operational system of record for the complete ITAD process.
