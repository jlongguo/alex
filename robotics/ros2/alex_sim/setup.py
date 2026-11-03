from glob import glob
from setuptools import setup
from os.path import join

package_name = 'alex_sim'
setup(
    name=package_name, version='0.14.0',
    packages=[package_name],
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        *[(join('share', package_name, folder), glob(folder + '/*'))
          for folder in ('launch', 'worlds', 'maps', 'urdf', 'config')],
        (join('share', package_name, 'models', 'alex_bot'), glob('models/alex_bot/*')),
    ],
    install_requires=['setuptools'], zip_safe=True,
    maintainer='Alex project', maintainer_email='noreply@example.invalid',
    description='Alex simulation-only robot and Gazebo home world',
    license='UNLICENSED',
    tests_require=['pytest'],
    entry_points={'console_scripts': ['seed_pose=alex_sim.seed_pose:main']},
)
