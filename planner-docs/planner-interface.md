# Planner interface

The early proposal has been superseded by the implemented shared models and
[PLANNER_INTEGRATION.md](../Docs/PLANNER_INTEGRATION.md).

Use PlanEngine.makeResult once per generation; retain the PlanResult and publish
its plan. Explanations use OfflineExplainer().explain with that exact retained result.
There is no live explanation service or PlanExplainer closure in the current app.
See [OFFLINE_EXPLANATION_INTEGRATION.md](../Docs/OFFLINE_EXPLANATION_INTEGRATION.md)
for the current Person C interface. Lamp & chat remains a separate feature.
