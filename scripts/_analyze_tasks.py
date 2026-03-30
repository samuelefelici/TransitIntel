#!/usr/bin/env python3
"""Temporary analysis script — delete after use."""
import json, sys, urllib.request
sys.path.insert(0, "/Users/samuelefelici/traffic/scripts")
from optimizer_common import *
from crew_scheduler_cpsat import build_tasks, enumerate_duties

# Load real scenario data via API
# First, get the scenario with its result (vehicle shifts)
url_scenario = "http://localhost:3000/api/service-program/scenarios/18313a68-39a7-4009-b30a-5b5227c6b9f9"
with urllib.request.urlopen(url_scenario) as resp:
    scenario = json.load(resp)

res = scenario.get("result", {})
raw_shifts = res.get("shifts", [])

if not raw_shifts:
    print("No vehicle shifts found, exiting")
    sys.exit(1)

print(f"Vehicle shifts: {len(raw_shifts)}")

tasks = build_tasks(raw_shifts)
print(f"Tasks: {len(tasks)}")

# Analyze tasks
total_driving = sum(t.driving_min for t in tasks)
avg_driving = total_driving / len(tasks) if tasks else 0
print(f"Total driving: {total_driving} min = {total_driving/60:.0f}h")
print(f"Avg driving per task: {avg_driving:.1f} min")
print(f"Target work per driver: {TARGET_WORK_LOW}-{TARGET_WORK_HIGH} min ({TARGET_WORK_LOW/60:.1f}-{TARGET_WORK_HIGH/60:.1f}h)")
print(f"Theoretical min drivers (driving only): {total_driving / TARGET_WORK_HIGH:.0f}")

# How many tasks per vehicle?
from collections import Counter
veh_counts = Counter(t.vehicle_id for t in tasks)
print(f"\nVehicles with tasks: {len(veh_counts)}")
print(f"Avg tasks per vehicle: {len(tasks)/len(veh_counts):.1f}")

# Task duration distribution
dur_buckets = Counter()
for t in tasks:
    bucket = (t.duration_min // 30) * 30
    dur_buckets[bucket] += 1
print(f"\nTask duration distribution (min):")
for k in sorted(dur_buckets.keys()):
    print(f"  {k:3d}-{k+29} min: {dur_buckets[k]:4d} tasks")

# Cluster coverage  
with_first_cluster = sum(1 for t in tasks if t.first_cluster)
with_last_cluster = sum(1 for t in tasks if t.last_cluster)
print(f"\nTasks with first_cluster: {with_first_cluster}")
print(f"Tasks with last_cluster: {with_last_cluster}")

# Enumerate duties
print("\n--- Enumerating duties ---")
duties = enumerate_duties(tasks, max_duties=25000)
print(f"Total duties: {len(duties)}")

# Duty type distribution
type_counts = Counter(d.duty_type for d in duties)
print(f"\nDuty type distribution:")
for t, c in type_counts.most_common():
    print(f"  {t}: {c}")

# Duty size distribution (tasks per duty)
size_counts = Counter(len(d.task_indices) for d in duties)
print(f"\nDuty size (tasks covered) distribution:")
for s in sorted(size_counts.keys()):
    print(f"  {s} tasks: {size_counts[s]} duties")

# Work distribution in duties
work_buckets = Counter()
for d in duties:
    bucket = (d.work_min // 60) * 60
    work_buckets[bucket] += 1
print(f"\nDuty work distribution (min):")
for k in sorted(work_buckets.keys()):
    print(f"  {k:3d}-{k+59} min: {work_buckets[k]:5d} duties")

# How many duties reach target work (390-402)?
good_work = sum(1 for d in duties if TARGET_WORK_LOW <= d.work_min <= TARGET_WORK_HIGH)
near_target = sum(1 for d in duties if 360 <= d.work_min <= 430)
print(f"\nDuties with work in target range ({TARGET_WORK_LOW}-{TARGET_WORK_HIGH}): {good_work}")
print(f"Duties with work near target (360-430): {near_target}")

# Check multi-task intero duties
intero_duties = [d for d in duties if d.duty_type == "intero"]
intero_multi = [d for d in intero_duties if len(d.task_indices) >= 3]
print(f"\nIntero duties: {len(intero_duties)}")
print(f"Intero with >=3 tasks: {len(intero_multi)}")
if intero_duties:
    avg_tasks_intero = sum(len(d.task_indices) for d in intero_duties) / len(intero_duties)
    print(f"Avg tasks per intero: {avg_tasks_intero:.1f}")
