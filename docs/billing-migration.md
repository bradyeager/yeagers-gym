# Billing data migration
The billing code, rosters, ledgers, logs, outbox claims and raw events are maintained in the private bradyeager/yeagers-gym-billing repository after CC-03 cutover.
The public website and GitHub Pages remain here. The public webhook receiver source writes only to the private billing archive.
Do not reintroduce billing records or automatic billing workflows here.
Deleting current files does not erase prior public Git history, branches, artifacts, caches or forks. Historical exposure needs a separate reviewed cleanup.