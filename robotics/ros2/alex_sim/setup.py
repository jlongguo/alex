"""Install only declared simulation assets, never Python cache directories.

The preflight/launch validator compiles launch/*.py and creates __pycache__.
A broad glob('launch/*') includes that directory and breaks colcon data_files
with "can't copy .../__pycache__: not a regular file".
"""
from glob import glob
from os.path import join
from pathlib import Path
from setuptools import setup

package_name = 'alex_sim'


def simulation_assets(folder, patterns):
    """Stable, file-only asset list for ament_python/setuptools data_files."""
    return sorted({
        path
        for pattern in patterns
        for path in glob(join(folder, pattern))
        if Path(path).is_file()
    })


simulation_folders = {
    'launch': ('*.py',),
    'worlds': ('*.sdf',),
    'maps': ('*.yaml', '*.pgm'),
    'urdf': ('*.urdf',),
    'config': ('*.yaml',),
}

setup(
    name=package_name, version='0.14.0',
    packages=[package_name],
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        *[(join('share', package_name, folder), simulation_assets(folder, patterns))
          for folder, patterns in simulation_folders.items()],
        (join('share', package_name, 'models', 'alex_bot'),
         simulation_assets('models/alex_bot', ('*.sdf', '*.config'))),
    ],
    install_requires=['setuptools'], zip_safe=True,
    maintainer='Alex project', maintainer_email='noreply@example.invalid',
    description='Alex simulation-only robot and Gazebo home world',
    license='UNLICENSED',
    tests_require=['pytest'],
    entry_points={'console_scripts': ['seed_pose=alex_sim.seed_pose:main']},
)
