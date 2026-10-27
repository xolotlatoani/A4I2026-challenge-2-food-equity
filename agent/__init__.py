"""Resilient Food Equity & Surplus Broker ADK package.

Owned by Person B (Agent Lane).
Exports `root_agent` for `adk web`, `adk run`, and Cloud Run deployment.
"""

from .agent import root_agent

__all__ = ["root_agent"]
