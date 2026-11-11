"""host-ops 适配器的静态脚本源（``khc_host.py``）。

该目录只放“Peer/Hub 共用脚本”的实现：``khc_host.py`` 会被 ``host_ops.py`` 与
``agent/khc/ops.py`` 拼接成单文件 ``khc-host``（Peer 上 0755、不常驻）。适配器本身
在上一级 ``agent/adapters/host_ops.py``。
"""
