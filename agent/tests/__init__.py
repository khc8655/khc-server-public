"""khc-agent 测试包（unittest discover -t agent 需要）。

测试不依赖 root / 网络；这里把 khc 日志压到 CRITICAL，避免断言失败时
日志与 unittest 输出混在一起（不影响被测逻辑）。
"""

from __future__ import annotations

import logging

logging.getLogger("khc").setLevel(logging.CRITICAL)
logging.getLogger("khc.http").setLevel(logging.CRITICAL)
